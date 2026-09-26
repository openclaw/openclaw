import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  generateMobileReleaseNotes,
  renderMobileReleaseNotes,
} from "../../scripts/lib/mobile-release-notes.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const api = vi.hoisted(() => ({ parse: vi.fn() }));
vi.mock("openai", () => ({
  default: class {
    responses = { parse: api.parse };
  },
}));
const temporary = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.unstubAllEnvs();
  api.parse.mockReset();
});

function git(root: string, ...args: string[]) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function fixture(platform: "ios" | "android" = "ios") {
  const rootDir = temporary.make("mobile-notes-");
  const write = (file: string, text: string) => {
    const target = path.join(rootDir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  };
  git(rootDir, "init", "-b", "main");
  git(rootDir, "config", "user.name", "Notes Fixture");
  git(rootDir, "config", "user.email", "notes@example.invalid");
  git(rootDir, "config", "commit.gpgsign", "false");
  git(rootDir, "remote", "add", "origin", rootDir);
  const file =
    platform === "ios" ? "apps/ios/Sources/Chat.swift" : "apps/android/app/src/play/java/Chat.kt";
  write(file, 'let label = "Send"\n');
  write("apps/ios/Sources/Reverted.swift", "let experimental = false\n");
  git(rootDir, "add", ".");
  git(rootDir, "commit", "-m", "Published app");
  const base = git(rootDir, "rev-parse", "HEAD");
  git(
    rootDir,
    "update-ref",
    `refs/openclaw/mobile-releases/${platform}/2026.7.3-${platform === "ios" ? "1" : "2026070301"}`,
    base,
  );
  write(file, 'let label = "Send message"\n');
  write("src/gateway/new-feature.ts", "export const unrelated = true;\n");
  write("apps/ios/Tests/Fixture.swift", "let unsupported = true\n");
  git(rootDir, "add", ".");
  git(rootDir, "commit", "-m", "Clarify send button; commit prose is supporting evidence only");
  const sourceSha = git(rootDir, "rev-parse", "HEAD");
  const baselines = (platform === "ios" ? ["ios"] : ["phone", "wear"]).map((audience) => ({
    audience,
    version: "2026.7.3",
    build: audience === "ios" ? "1" : audience === "phone" ? "2026070301" : "2026070351",
  }));
  const plan =
    platform === "ios"
      ? {
          appStoreVersion: "2026.7.40",
          buildNumber: 2,
          sourceSha,
          releaseNotesBaselines: baselines,
        }
      : {
          version: "2026.7.4",
          versionCode: 2026070401,
          wearVersionCode: 2026070451,
          sourceSha,
          releaseNotesBaselines: baselines,
        };
  const planPath = path.join(rootDir, "plan.json");
  fs.writeFileSync(planPath, JSON.stringify(plan));
  const outputPath = path.join(rootDir, "notes.json");
  vi.stubEnv("OPENAI_API_KEY", "synthetic-key");
  return { rootDir, platform, planPath, outputPath, sourceSha, plan, base, file, write };
}

const claim = { text: "Clearer labels when sending messages.", evidenceIds: ["e1"] };
function accept() {
  api.parse
    .mockResolvedValueOnce({ status: "completed", output_parsed: { changes: [claim] } })
    .mockResolvedValueOnce({ status: "completed", output_parsed: { changes: [claim] } })
    .mockResolvedValueOnce({
      status: "completed",
      output_parsed: { approved: true, problems: [] },
    });
}

describe("generated mobile store notes", () => {
  it("uses endpoint app evidence and freezes notes for replay, rejecting wrong source, identity, baseline, or edited text", async () => {
    const f = fixture();
    f.write(
      "apps/shared/OpenClawWatchRTC/src/lib.rs",
      "pub fn reconnect_enabled() -> bool { true }\n",
    );
    git(f.rootDir, "add", "apps/shared/OpenClawWatchRTC/src/lib.rs");
    git(f.rootDir, "commit", "-m", "Enable watch reconnect");
    f.sourceSha = git(f.rootDir, "rev-parse", "HEAD");
    f.plan.sourceSha = f.sourceSha;
    fs.writeFileSync(f.planPath, JSON.stringify(f.plan));
    accept();
    const saved = await generateMobileReleaseNotes(f);
    const evidence = JSON.parse(api.parse.mock.calls[0]![0].input);
    expect(evidence).toHaveLength(2);
    expect(evidence[1].file).toBe("apps/shared/OpenClawWatchRTC/src/lib.rs");
    expect(evidence[0].file).toBe(f.file);
    expect(evidence[0].patch).toContain('+let label = "Send message"');
    expect(saved.entries[0]?.text).toBe("- Clearer labels when sending messages.");
    expect(saved.entries[0]?.baseline.sourceSha).toBe(f.base);
    vi.stubEnv("OPENAI_API_KEY", "");
    expect(await generateMobileReleaseNotes(f)).toEqual(saved);
    expect(api.parse).toHaveBeenCalledTimes(3);
    const render = {
      rootDir: f.rootDir,
      platform: f.platform,
      version: "2026.7.40",
      build: "2",
      audience: "ios" as const,
      artifactPath: f.outputPath,
    };
    expect(renderMobileReleaseNotes(render)).toBe(saved.entries[0]?.text);
    expect(() => renderMobileReleaseNotes({ ...render, build: "3" })).toThrow("build must match");
    git(f.rootDir, "checkout", "--detach", f.base);
    expect(() => renderMobileReleaseNotes(render)).toThrow("sourceSha must match");
    git(f.rootDir, "checkout", "main");
    const changed = structuredClone(saved);
    changed.entries[0]!.text = "Invented feature";
    fs.writeFileSync(f.outputPath, JSON.stringify(changed));
    expect(() => renderMobileReleaseNotes(render)).toThrow("content digest");
    fs.writeFileSync(f.outputPath, JSON.stringify(saved));
    f.plan.releaseNotesBaselines[0]!.build = "2";
    fs.writeFileSync(f.planPath, JSON.stringify(f.plan));
    await expect(generateMobileReleaseNotes(f)).rejects.toThrow("different production baseline");
  });

  it("keeps phone and Wear baselines and saved text separate while resolving their shared upload ref", async () => {
    const f = fixture("android");
    accept();
    api.parse.mockResolvedValue({ status: "completed", output_parsed: { changes: [] } });
    api.parse
      .mockResolvedValueOnce({ status: "completed", output_parsed: { changes: [] } })
      .mockResolvedValueOnce({ status: "completed", output_parsed: { changes: [] } })
      .mockResolvedValueOnce({
        status: "completed",
        output_parsed: { approved: true, problems: [] },
      });
    const saved = await generateMobileReleaseNotes(f);
    expect(
      saved.entries.map((entry) => [
        entry.audience,
        entry.baseline.build,
        entry.baseline.sourceSha,
        entry.text,
      ]),
    ).toEqual([
      ["phone", "2026070301", f.base, "- Clearer labels when sending messages."],
      ["wear", "2026070351", f.base, "Bug fixes and improvements."],
    ]);
  });

  it("does not invent notes for a fully reverted app change", async () => {
    const f = fixture();
    f.write(f.file, 'let label = "Send"\n');
    git(f.rootDir, "add", f.file);
    git(f.rootDir, "commit", "-m", "Revert candidate UI change");
    f.plan.sourceSha = git(f.rootDir, "rev-parse", "HEAD");
    fs.writeFileSync(f.planPath, JSON.stringify(f.plan));
    const saved = await generateMobileReleaseNotes({ ...f, sourceSha: f.plan.sourceSha });
    expect(saved.entries[0]?.text).toBe("Bug fixes and improvements.");
    expect(api.parse).not.toHaveBeenCalled();
  });

  it("refuses a missing public source mapping before asking the model", async () => {
    const f = fixture();
    git(f.rootDir, "update-ref", "-d", "refs/openclaw/mobile-releases/ios/2026.7.3-1");
    await expect(generateMobileReleaseNotes(f)).rejects.toThrow("Missing source mapping");
    expect(api.parse).not.toHaveBeenCalled();
    expect(fs.existsSync(f.outputPath)).toBe(false);
  });

  it("rejects repeated unsupported model claims without creating an uploadable artifact", async () => {
    const f = fixture();
    api.parse.mockResolvedValueOnce({ status: "completed", output_parsed: { changes: [claim] } });
    for (let index = 0; index < 3; index++) {
      api.parse
        .mockResolvedValueOnce({ status: "completed", output_parsed: { changes: [claim] } })
        .mockResolvedValueOnce({
          status: "completed",
          output_parsed: { approved: false, problems: ["Unsupported behavior claim."] },
        });
    }
    await expect(generateMobileReleaseNotes(f)).rejects.toThrow(
      "Could not validate ios release notes",
    );
    expect(api.parse).toHaveBeenCalledTimes(7);
    expect(fs.existsSync(f.outputPath)).toBe(false);
  });

  it("rejects incomplete API output without saving partial notes", async () => {
    const f = fixture();
    api.parse.mockResolvedValue({ status: "incomplete", output_parsed: { changes: [] } });
    await expect(generateMobileReleaseNotes(f)).rejects.toThrow("did not complete");
    expect(fs.existsSync(f.outputPath)).toBe(false);
  });
});
