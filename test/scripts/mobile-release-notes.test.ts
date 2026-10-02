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
  vi.restoreAllMocks();
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
  if (platform === "android") {
    write("apps/android/wear/src/main/java/Watch.kt", 'val label = "Talk"\n');
    write(
      "apps/android/app/src/play/java/ai/openclaw/app/SensitiveFeatureConfig.kt",
      "object SensitiveFeatureConfig {\n  const val smsEnabled = false\n  const val accessibilityControlEnabled = false\n}\n",
    );
  }
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
function select(files: Array<{ file: string; focus: string[] }>) {
  api.parse.mockImplementationOnce((request: { input: string }) => {
    const inventory: { files: Array<{ id: string; file: string }> } = JSON.parse(request.input);
    return {
      status: "completed",
      output_parsed: {
        files: files.map(({ file, focus }) => {
          const entry = inventory.files.find((candidate) => candidate.file === file);
          if (!entry) {
            throw new Error(`Missing fixture selection: ${file}`);
          }
          return { id: entry.id, focus };
        }),
      },
    };
  });
}

function accept(files: Array<{ file: string; focus: string[] }>, changes = [claim]) {
  select(files);
  api.parse
    .mockResolvedValueOnce({ status: "completed", output_parsed: { changes } })
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
    accept([
      { file: f.file, focus: ["label"] },
      { file: "apps/shared/OpenClawWatchRTC/src/lib.rs", focus: ["reconnect_enabled"] },
    ]);
    const saved = await generateMobileReleaseNotes(f);
    const draft = JSON.parse(api.parse.mock.calls[1]![0].input);
    const evidence = draft.evidence.filter((entry: { kind?: string }) => entry.kind !== "context");
    expect(evidence).toHaveLength(2);
    expect(evidence[1].file).toBe("apps/shared/OpenClawWatchRTC/src/lib.rs");
    expect(evidence[0].file).toBe(f.file);
    expect(evidence[0].patch).toContain('+let label = "Send message"');
    expect(saved.entries[0]?.text).toBe("- Clearer labels when sending messages.");
    expect(saved.entries[0]?.baseline.sourceSha).toBe(f.base);
    expect(saved.promptVersion).toBe(3);
    const historical = { ...saved, promptVersion: 2 };
    fs.writeFileSync(f.outputPath, JSON.stringify(historical));
    const historicalBytes = fs.readFileSync(f.outputPath, "utf8");
    vi.stubEnv("OPENAI_API_KEY", "");
    expect(await generateMobileReleaseNotes(f)).toEqual(historical);
    expect(fs.readFileSync(f.outputPath, "utf8")).toBe(historicalBytes);
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

  it.each(["legacy", "v2"])(
    "keeps phone and Wear baselines and text separate with %s source records",
    async (scheme) => {
      const f = fixture("android");
      const sourceRef =
        "refs/openclaw/mobile-releases/android/v2/2026.7.3/0/1/2026070449-2026070450";
      const wearBase = f.sourceSha;
      git(
        f.rootDir,
        "update-ref",
        "refs/openclaw/mobile-releases/android/2026.7.3-2026070302",
        wearBase,
      );
      f.plan.releaseNotesBaselines[1] = {
        audience: "wear",
        version: "2026.7.3",
        build: "2026070352",
      };
      const wearFile = "apps/android/wear/src/main/java/Watch.kt";
      f.write(wearFile, 'val label = "Start talking"\n');
      git(f.rootDir, "add", wearFile);
      git(f.rootDir, "commit", "-m", "Clarify watch voice action");
      f.sourceSha = git(f.rootDir, "rev-parse", "HEAD");
      f.plan.sourceSha = f.sourceSha;
      fs.writeFileSync(f.planPath, JSON.stringify(f.plan));
      if (scheme === "v2") {
        git(f.rootDir, "update-ref", sourceRef, f.base);
        f.plan.releaseNotesBaselines[0] = {
          audience: "phone",
          version: "2026.7.30",
          build: "2026070449",
        };
        fs.writeFileSync(
          f.planPath,
          JSON.stringify({
            ...f.plan,
            releaseNotesBaselines: [
              { ...f.plan.releaseNotesBaselines[0], sourceRef },
              f.plan.releaseNotesBaselines[1],
            ],
          }),
        );
      }
      accept([{ file: f.file, focus: ["label"] }]);
      accept(
        [{ file: wearFile, focus: ["label"] }],
        [{ text: "Clearer watch voice controls.", evidenceIds: ["e1"] }],
      );
      const saved = await generateMobileReleaseNotes(f);
      const wearInventory = JSON.parse(api.parse.mock.calls[3]![0].input);
      expect(wearInventory.files).toEqual(
        expect.arrayContaining([expect.objectContaining({ file: wearFile })]),
      );
      expect(wearInventory.files).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ file: f.file })]),
      );
      for (const index of [2, 5]) {
        const review = JSON.parse(api.parse.mock.calls[index]![0].input);
        expect(review.evidence).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              file: "apps/android/app/src/play/java/ai/openclaw/app/SensitiveFeatureConfig.kt",
              kind: "context",
              patch: expect.stringContaining("smsEnabled = false"),
            }),
          ]),
        );
      }
      expect(
        saved.entries.map((entry) => [
          entry.audience,
          entry.baseline.build,
          entry.baseline.sourceSha,
          entry.text,
        ]),
      ).toEqual([
        [
          "phone",
          scheme === "v2" ? "2026070449" : "2026070301",
          f.base,
          "- Clearer labels when sending messages.",
        ],
        ["wear", "2026070352", wearBase, "- Clearer watch voice controls."],
      ]);
      vi.stubEnv("OPENAI_API_KEY", "");
      expect(await generateMobileReleaseNotes(f)).toEqual(saved);
      if (scheme === "v2") {
        fs.rmSync(f.outputPath);
        vi.stubEnv("OPENAI_API_KEY", "synthetic-key");
        const plan = JSON.parse(fs.readFileSync(f.planPath, "utf8"));
        plan.releaseNotesBaselines[0].build = "2026070450";
        fs.writeFileSync(f.planPath, JSON.stringify(plan));
        await expect(generateMobileReleaseNotes(f)).rejects.toThrow(
          "does not match its recorded store identity",
        );
      }
    },
  );

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

  it("shortlists a real change without sending generated, UI-test, or raw localization noise", async () => {
    const f = fixture();
    const generatedFile = "apps/shared/OpenClawKit/Sources/OpenClawProtocol/GatewayModels.swift";
    const uiTestFile = "apps/ios/UITests/ReleaseTests.swift";
    const localizationFile = "apps/ios/Resources/Localizable.xcstrings";
    f.write(
      generatedFile,
      "// Generated file. Do not edit.\n" + "struct GeneratedModel {}\n".repeat(6000),
    );
    f.write(uiTestFile, "func testUnsupportedFeature() {}\n".repeat(6000));
    f.write(
      localizationFile,
      JSON.stringify({
        sourceLanguage: "en",
        version: "1.0",
        strings: Object.fromEntries(
          Array.from({ length: 500 }, (_, index) => [
            `message-${index}`,
            {
              localizations: {
                es: {
                  stringUnit: { state: "translated", value: "LOCALIZATION_ONLY_NOISE".repeat(24) },
                },
              },
            },
          ]),
        ),
      }),
    );
    git(f.rootDir, "add", generatedFile, uiTestFile, localizationFile);
    git(f.rootDir, "commit", "-m", "Refresh generated declarations, translations, and UI checks");
    f.sourceSha = git(f.rootDir, "rev-parse", "HEAD");
    f.plan.sourceSha = f.sourceSha;
    fs.writeFileSync(f.planPath, JSON.stringify(f.plan));
    api.parse.mockImplementationOnce((request: { input: string }) => {
      // The original generator exceeds this budget before it can select the useful change.
      expect(request.input.length).toBeLessThan(60_000);
      const inventory: { files: Array<{ id: string; file: string; summary?: unknown }> } =
        JSON.parse(request.input);
      expect(inventory.files).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ file: generatedFile })]),
      );
      expect(inventory.files).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ file: uiTestFile })]),
      );
      const localization = inventory.files.find((entry) => entry.file === localizationFile);
      expect(localization?.summary).toBeDefined();
      expect(JSON.stringify(localization)).toContain("es");
      expect(request.input).not.toContain("LOCALIZATION_ONLY_NOISE");
      const selected = inventory.files.find((entry) => entry.file === f.file);
      expect(selected).toBeDefined();
      return {
        status: "completed",
        output_parsed: { files: [{ id: selected?.id, focus: ["label"] }] },
      };
    });
    api.parse
      .mockResolvedValueOnce({ status: "completed", output_parsed: { changes: [claim] } })
      .mockResolvedValueOnce({
        status: "completed",
        output_parsed: { approved: true, problems: [] },
      });

    const saved = await generateMobileReleaseNotes(f);
    expect(api.parse).toHaveBeenCalledTimes(3);
    for (const index of [1, 2]) {
      const request = api.parse.mock.calls[index]![0];
      expect(request.input.length).toBeLessThan(60_000);
      const input = JSON.parse(request.input);
      expect(input.evidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file: f.file,
            patch: expect.stringContaining('+let label = "Send message"'),
          }),
        ]),
      );
      expect(request.input).not.toContain("LOCALIZATION_ONLY_NOISE");
      expect(request.input).not.toContain("testUnsupportedFeature");
      expect(request.input).not.toContain("struct GeneratedModel");
    }
    expect(saved.entries[0]?.text).toBe("- Clearer labels when sending messages.");
  });

  it.each([
    { files: [], error: /too small/iu },
    { files: [{ id: "f9999", focus: ["label"] }], error: /selection|selected|unknown/iu },
  ])("rejects an empty or unknown shortlist before drafting: $files", async ({ files, error }) => {
    const f = fixture();
    api.parse.mockResolvedValueOnce({ status: "completed", output_parsed: { files } });
    await expect(generateMobileReleaseNotes(f)).rejects.toThrow(error);
    expect(api.parse).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(f.outputPath)).toBe(false);
  });

  it("supplies current capabilities when there is no public release baseline", async () => {
    const f = fixture();
    fs.writeFileSync(
      f.planPath,
      JSON.stringify({
        ...f.plan,
        releaseNotesBaselines: [{ audience: "ios", version: null, build: null }],
      }),
    );
    git(f.rootDir, "remote", "remove", "origin");
    accept(
      [{ file: f.file, focus: ["label"] }],
      [{ text: "Send messages in chat.", evidenceIds: ["e1"] }],
    );
    const saved = await generateMobileReleaseNotes(f);
    const draft = JSON.parse(api.parse.mock.calls[1]![0].input);
    expect(draft.evidence[0].patch).toBe('let label = "Send message"\n');
    expect(saved.entries[0]?.baseline.sourceSha).toBeNull();
    expect(saved.entries[0]?.text).toBe("- Send messages in chat.");
  });

  it("keeps exact Android resource moves as path-sensitive release evidence", async () => {
    const f = fixture("android");
    const original = "apps/android/app/src/main/res/values/strings.xml";
    const moved = "apps/android/app/src/main/res/values-en/strings.xml";
    f.write(original, '<resources><string name="send">Send message</string></resources>\n');
    git(f.rootDir, "add", original);
    git(f.rootDir, "commit", "-m", "Published resource");
    git(
      f.rootDir,
      "update-ref",
      "refs/openclaw/mobile-releases/android/2026.7.3-2026070301",
      "HEAD",
    );
    fs.mkdirSync(path.dirname(path.join(f.rootDir, moved)), { recursive: true });
    fs.renameSync(path.join(f.rootDir, original), path.join(f.rootDir, moved));
    git(f.rootDir, "add", "-A");
    git(f.rootDir, "commit", "-m", "Restrict resource to English");
    f.sourceSha = git(f.rootDir, "rev-parse", "HEAD");
    f.plan.sourceSha = f.sourceSha;
    fs.writeFileSync(f.planPath, JSON.stringify(f.plan));
    accept(
      [{ file: moved, focus: ["send"] }],
      [{ text: "Updated English labels.", evidenceIds: ["e1"] }],
    );
    accept([{ file: moved, focus: ["send"] }], []);
    const saved = await generateMobileReleaseNotes(f);
    const draft = JSON.parse(api.parse.mock.calls[1]![0].input);
    expect(draft.evidence[0].patch).toContain("similarity index 100%");
    expect(draft.evidence[0].patch).toContain(`rename from ${original}`);
    expect(draft.evidence[0].patch).toContain(`rename to ${moved}`);
    expect(saved.entries[0]?.text).toBe("- Updated English labels.");
  });

  it("stops after the overall budget expires without starting a draft or saving notes", async () => {
    const f = fixture();
    const started = Date.now();
    let now = started;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    api.parse.mockImplementationOnce(() => {
      now = started + 300_001;
      return {
        status: "completed",
        output_parsed: { files: [{ id: "f1", focus: ["label"] }] },
      };
    });
    await expect(generateMobileReleaseNotes(f)).rejects.toThrow(/budget|deadline|timed out/iu);
    expect(api.parse).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(f.outputPath)).toBe(false);
  });

  it("refuses a missing public source mapping before asking the model", async () => {
    const f = fixture();
    git(f.rootDir, "update-ref", "-d", "refs/openclaw/mobile-releases/ios/2026.7.3-1");
    await expect(generateMobileReleaseNotes(f)).rejects.toThrow("Missing source mapping");
    expect(api.parse).not.toHaveBeenCalled();
    expect(fs.existsSync(f.outputPath)).toBe(false);
  });

  it("reviews selected changes after an empty draft and saves the corrected highlights", async () => {
    const f = fixture();
    const correction = "e1: The changed send label is missing from the empty draft.";
    select([{ file: f.file, focus: ["label"] }]);
    api.parse
      .mockResolvedValueOnce({ status: "completed", output_parsed: { changes: [] } })
      .mockImplementationOnce((request: { input: string }) => {
        const review = JSON.parse(request.input);
        expect(review.draft.changes).toEqual([]);
        expect(review.evidence).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: "e1",
              file: f.file,
              patch: expect.stringContaining('+let label = "Send message"'),
            }),
          ]),
        );
        return {
          status: "completed",
          output_parsed: { approved: false, problems: [correction] },
        };
      })
      .mockImplementationOnce((request: { input: string }) => {
        expect(JSON.parse(request.input).corrections).toEqual([correction]);
        return { status: "completed", output_parsed: { changes: [claim] } };
      })
      .mockResolvedValueOnce({
        status: "completed",
        output_parsed: { approved: true, problems: [] },
      });

    const saved = await generateMobileReleaseNotes(f);
    expect(api.parse).toHaveBeenCalledTimes(5);
    expect(saved.entries[0]?.claims).toEqual([claim]);
    expect(
      renderMobileReleaseNotes({
        rootDir: f.rootDir,
        platform: f.platform,
        version: "2026.7.40",
        build: "2",
        audience: "ios",
        artifactPath: f.outputPath,
      }),
    ).toBe("- Clearer labels when sending messages.");
  });

  it("rejects repeated unsupported model claims without creating an uploadable artifact", async () => {
    const f = fixture();
    select([{ file: f.file, focus: ["label"] }]);
    for (let index = 0; index < 2; index++) {
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
    expect(api.parse).toHaveBeenCalledTimes(5);
    expect(fs.existsSync(f.outputPath)).toBe(false);
  });

  it("rejects incomplete API output without saving partial notes", async () => {
    const f = fixture();
    api.parse.mockResolvedValue({ status: "incomplete", output_parsed: { changes: [] } });
    await expect(generateMobileReleaseNotes(f)).rejects.toThrow("did not complete");
    expect(fs.existsSync(f.outputPath)).toBe(false);
  });
});
