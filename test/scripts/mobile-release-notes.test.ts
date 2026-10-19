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

const git = (root: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

function fixture(platform: "ios" | "android" = "ios") {
  const rootDir = temporary.make("mobile-notes-");
  const write = (file: string, text: string) => {
    const target = path.join(rootDir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  };
  const ref = (name: string, sha: string) => git(rootDir, "update-ref", name, sha);
  git(rootDir, "init", "-b", "main");
  git(rootDir, "config", "user.name", "Notes Fixture");
  git(rootDir, "config", "user.email", "notes@example.invalid");
  git(rootDir, "config", "commit.gpgsign", "false");
  git(rootDir, "remote", "add", "origin", rootDir);
  const file =
    platform === "ios" ? "apps/ios/Sources/Chat.swift" : "apps/android/app/src/play/java/Chat.kt";
  write(file, 'let label = "Send"\n');
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
  ref(
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
  const plan = {
    ...(platform === "ios"
      ? { appStoreVersion: "2026.7.40", buildNumber: 2 }
      : { version: "2026.7.4", versionCode: 2026070401, wearVersionCode: 2026070451 }),
    sourceSha,
    releaseNotesBaselines: baselines,
  };
  const planPath = path.join(rootDir, "plan.json");
  fs.writeFileSync(planPath, JSON.stringify(plan));
  const outputPath = path.join(rootDir, "notes.json");
  vi.stubEnv("OPENAI_API_KEY", "synthetic-key");
  return { rootDir, platform, planPath, outputPath, sourceSha, plan, base, file, write, ref };
}

const claim = { text: "Clearer labels when sending messages.", evidenceIds: ["e1"] };
const noisyTranslation = { state: "translated", value: "LOCALIZATION_ONLY_NOISE".repeat(24) };
const renderIdentity = { version: "2026.7.40", build: "2", audience: "ios" as const };
const completed = (output_parsed: unknown) => ({ status: "completed", output_parsed });
const approvedReview = completed({ approved: true, problems: [] });
const requestInput = (index: number) => JSON.parse(api.parse.mock.calls[index]![0].input);
const savePlan = (f: ReturnType<typeof fixture>, overrides: object = {}) =>
  fs.writeFileSync(f.planPath, JSON.stringify({ ...f.plan, ...overrides }));
const saveNotes = (f: ReturnType<typeof fixture>, notes: unknown) =>
  fs.writeFileSync(f.outputPath, JSON.stringify(notes));
const readNotes = (f: ReturnType<typeof fixture>) => fs.readFileSync(f.outputPath, "utf8");
const labelEvidence = (file: string, fields: object = {}) =>
  expect.objectContaining({
    file,
    patch: expect.stringContaining('+let label = "Send message"'),
    ...fields,
  });
function commit(f: ReturnType<typeof fixture>, message: string, ...files: string[]) {
  git(f.rootDir, "add", ...files);
  git(f.rootDir, "commit", "-m", message);
  f.sourceSha = git(f.rootDir, "rev-parse", "HEAD");
  f.plan.sourceSha = f.sourceSha;
}
const renderOptions = (f: ReturnType<typeof fixture>) => ({
  ...f,
  ...renderIdentity,
  artifactPath: f.outputPath,
});
function select(file: string, focus = "label") {
  api.parse.mockImplementationOnce((request: { input: string }) => {
    const inventory: { files: Array<{ id: string; file: string }> } = JSON.parse(request.input);
    const entry = inventory.files.find((candidate) => candidate.file === file);
    if (!entry) {
      throw new Error(`Missing fixture selection: ${file}`);
    }
    return completed({ files: [{ id: entry.id, focus: [focus] }] });
  });
}

function accept(file: string, changes = [claim], focus = "label") {
  select(file, focus);
  api.parse.mockResolvedValueOnce(completed({ changes })).mockResolvedValueOnce(approvedReview);
}

describe("generated mobile store notes", () => {
  it("selects bounded app evidence and freezes notes for replay with source, identity, baseline, and text validation", async () => {
    const f = fixture();
    const watchFile = "apps/shared/OpenClawWatchRTC/src/lib.rs";
    f.write(watchFile, "pub fn reconnect_enabled() -> bool { true }\n");
    commit(f, "Enable watch reconnect", watchFile);
    const generatedFile = "apps/shared/OpenClawKit/Sources/OpenClawProtocol/GatewayModels.swift";
    const uiTestFile = "apps/ios/UITests/ReleaseTests.swift";
    const localizationFile = "apps/ios/Resources/Localizable.xcstrings";
    f.write(
      generatedFile,
      "// Generated file. Do not edit.\n" + "struct GeneratedModel {}\n".repeat(6000),
    );
    f.write(uiTestFile, "func testUnsupportedFeature() {}\n".repeat(6000));
    const strings = Object.fromEntries(
      Array.from({ length: 500 }, (_, index) => [
        `message-${index}`,
        { localizations: { es: { stringUnit: noisyTranslation } } },
      ]),
    );
    f.write(localizationFile, JSON.stringify({ sourceLanguage: "en", version: "1.0", strings }));
    commit(
      f,
      "Refresh generated declarations, translations, and UI checks",
      generatedFile,
      uiTestFile,
      localizationFile,
    );
    savePlan(f);
    api.parse.mockImplementationOnce((request: { input: string }) => {
      expect(request.input.length).toBeLessThan(60_000);
      const inventory: { files: Array<{ id: string; file: string; summary?: unknown }> } =
        JSON.parse(request.input);
      for (const file of [generatedFile, uiTestFile]) {
        expect(inventory.files).not.toContainEqual(expect.objectContaining({ file }));
      }
      const localization = inventory.files.find((entry) => entry.file === localizationFile);
      expect(localization?.summary).toBeDefined();
      expect(JSON.stringify(localization)).toContain("es");
      expect(request.input).not.toContain("LOCALIZATION_ONLY_NOISE");
      const selected = inventory.files.find((entry) => entry.file === f.file);
      expect(selected).toBeDefined();
      return completed({
        files: [
          { id: selected?.id, focus: ["label"] },
          {
            id: inventory.files.find((entry) => entry.file === watchFile)?.id,
            focus: ["reconnect_enabled"],
          },
        ],
      });
    });
    api.parse
      .mockResolvedValueOnce(completed({ changes: [claim] }))
      .mockResolvedValueOnce(approvedReview);

    const saved = await generateMobileReleaseNotes(f);
    expect(api.parse).toHaveBeenCalledTimes(3);
    for (const index of [1, 2]) {
      const request = api.parse.mock.calls[index]![0];
      expect(request.input.length).toBeLessThan(60_000);
      expect(JSON.parse(request.input).evidence).toContainEqual(labelEvidence(f.file));
      expect(request.input).not.toMatch(
        /LOCALIZATION_ONLY_NOISE|testUnsupportedFeature|struct GeneratedModel/,
      );
    }
    const evidence = requestInput(1).evidence.filter(
      (entry: { kind?: string }) => entry.kind !== "context",
    );
    expect(evidence).toMatchObject([labelEvidence(f.file), { file: watchFile }]);
    expect(saved).toMatchObject({
      entries: [{ text: `- ${claim.text}`, baseline: { sourceSha: f.base } }],
      promptVersion: 3,
    });
    const historical = { ...saved, promptVersion: 2 };
    saveNotes(f, historical);
    const historicalBytes = readNotes(f);
    vi.stubEnv("OPENAI_API_KEY", "");
    expect(await generateMobileReleaseNotes(f)).toEqual(historical);
    expect(readNotes(f)).toBe(historicalBytes);
    expect(api.parse).toHaveBeenCalledTimes(3);
    const render = renderOptions(f);
    expect(renderMobileReleaseNotes(render)).toBe(saved.entries[0]?.text);
    expect(() => renderMobileReleaseNotes({ ...render, build: "3" })).toThrow("build must match");
    git(f.rootDir, "checkout", "--detach", f.base);
    expect(() => renderMobileReleaseNotes(render)).toThrow("sourceSha must match");
    git(f.rootDir, "checkout", "main");
    const changed = structuredClone(saved);
    changed.entries[0]!.text = "Invented feature";
    saveNotes(f, changed);
    expect(() => renderMobileReleaseNotes(render)).toThrow("content digest");
    saveNotes(f, saved);
    f.plan.releaseNotesBaselines[0]!.build = "2";
    savePlan(f);
    await expect(generateMobileReleaseNotes(f)).rejects.toThrow("different production baseline");
  });

  it("keeps v2 phone and legacy Wear baselines and text separate", async () => {
    const f = fixture("android");
    const sourceRef = "refs/openclaw/mobile-releases/android/v2/2026.7.3/0/1/2026070449-2026070450";
    const wearBase = f.sourceSha;
    f.ref("refs/openclaw/mobile-releases/android/2026.7.3-2026070302", wearBase);
    f.plan.releaseNotesBaselines[1]!.build = "2026070352";
    const wearFile = "apps/android/wear/src/main/java/Watch.kt";
    f.write(wearFile, 'val label = "Start talking"\n');
    commit(f, "Clarify watch voice action", wearFile);
    f.ref(sourceRef, f.base);
    Object.assign(f.plan.releaseNotesBaselines[0]!, { version: "2026.7.30", build: "2026070449" });
    savePlan(f, {
      releaseNotesBaselines: [
        { ...f.plan.releaseNotesBaselines[0], sourceRef },
        f.plan.releaseNotesBaselines[1],
      ],
    });
    accept(f.file);
    accept(wearFile, [{ text: "Clearer watch voice controls.", evidenceIds: ["e1"] }]);
    const saved = await generateMobileReleaseNotes(f);
    expect(requestInput(3).files).toContainEqual(expect.objectContaining({ file: wearFile }));
    expect(requestInput(3).files).not.toContainEqual(expect.objectContaining({ file: f.file }));
    for (const index of [2, 5]) {
      expect(requestInput(index).evidence).toContainEqual(
        expect.objectContaining({
          file: "apps/android/app/src/play/java/ai/openclaw/app/SensitiveFeatureConfig.kt",
          kind: "context",
          patch: expect.stringContaining("smsEnabled = false"),
        }),
      );
    }
    const rows = saved.entries.map(({ audience, baseline: { build, sourceSha }, text }) => [
      audience,
      build,
      sourceSha,
      text,
    ]);
    expect(rows).toEqual([
      ["phone", "2026070449", f.base, `- ${claim.text}`],
      ["wear", "2026070352", wearBase, "- Clearer watch voice controls."],
    ]);
    vi.stubEnv("OPENAI_API_KEY", "");
    expect(await generateMobileReleaseNotes(f)).toEqual(saved);
    fs.rmSync(f.outputPath);
    vi.stubEnv("OPENAI_API_KEY", "synthetic-key");
    const plan = JSON.parse(fs.readFileSync(f.planPath, "utf8"));
    plan.releaseNotesBaselines[0].build = "2026070450";
    fs.writeFileSync(f.planPath, JSON.stringify(plan));
    await expect(generateMobileReleaseNotes(f)).rejects.toThrow(
      "does not match its recorded store identity",
    );
  });

  it("does not invent notes for a fully reverted app change", async () => {
    const f = fixture();
    f.write(f.file, 'let label = "Send"\n');
    commit(f, "Revert candidate UI change", f.file);
    savePlan(f);
    const saved = await generateMobileReleaseNotes(f);
    expect(saved.entries[0]?.text).toBe("Bug fixes and improvements.");
    expect(api.parse).not.toHaveBeenCalled();
  });

  it.each([
    ["empty shortlist", [], /too small/iu],
    ["unknown shortlist", [{ id: "f9999", focus: ["label"] }], /selection|selected|unknown/iu],
    ["incomplete response", undefined, /did not complete/u],
    ["expired budget", [{ id: "f1", focus: ["label"] }], /budget|deadline|timed out/iu],
    ["missing source mapping", undefined, /Missing source mapping/u],
  ] as const)("rejects %s without saving partial notes", async (name, files, error) => {
    const f = fixture();
    if (name === "missing source mapping") {
      git(f.rootDir, "update-ref", "-d", "refs/openclaw/mobile-releases/ios/2026.7.3-1");
    } else if (name === "expired budget") {
      const started = Date.now();
      let now = started;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      api.parse.mockImplementationOnce(() => {
        now = started + 300_001;
        return completed({ files });
      });
    } else {
      api.parse.mockResolvedValueOnce(
        files ? completed({ files }) : { status: "incomplete", output_parsed: { changes: [] } },
      );
    }
    await expect(generateMobileReleaseNotes(f)).rejects.toThrow(error);
    expect(api.parse).toHaveBeenCalledTimes(name === "missing source mapping" ? 0 : 1);
    expect(fs.existsSync(f.outputPath)).toBe(false);
  });

  it("supplies current capabilities when there is no public release baseline", async () => {
    const f = fixture();
    savePlan(f, { releaseNotesBaselines: [{ audience: "ios", version: null, build: null }] });
    git(f.rootDir, "remote", "remove", "origin");
    accept(f.file, [{ text: "Send messages in chat.", evidenceIds: ["e1"] }]);
    const saved = await generateMobileReleaseNotes(f);
    expect(requestInput(1).evidence[0].patch).toBe('let label = "Send message"\n');
    expect(saved.entries[0]).toMatchObject({
      baseline: { sourceSha: null },
      text: "- Send messages in chat.",
    });
  });

  it("keeps exact Android resource moves as path-sensitive release evidence", async () => {
    const f = fixture("android");
    const original = "apps/android/app/src/main/res/values/strings.xml";
    const moved = "apps/android/app/src/main/res/values-en/strings.xml";
    f.write(original, '<resources><string name="send">Send message</string></resources>\n');
    commit(f, "Published resource", original);
    f.ref("refs/openclaw/mobile-releases/android/2026.7.3-2026070301", "HEAD");
    fs.mkdirSync(path.dirname(path.join(f.rootDir, moved)), { recursive: true });
    fs.renameSync(path.join(f.rootDir, original), path.join(f.rootDir, moved));
    commit(f, "Restrict resource to English", "-A");
    savePlan(f);
    accept(moved, [{ text: "Updated English labels.", evidenceIds: ["e1"] }], "send");
    accept(moved, [], "send");
    const saved = await generateMobileReleaseNotes(f);
    for (const text of ["similarity index 100%", `rename from ${original}`, `rename to ${moved}`]) {
      expect(requestInput(1).evidence[0].patch).toContain(text);
    }
    expect(saved.entries[0]?.text).toBe("- Updated English labels.");
  });

  it.each([true, false])(
    "publishes corrected highlights only after factual review (approved=%s)",
    async (approved) => {
      const f = fixture();
      const changes = approved ? [] : [claim];
      const correction = approved
        ? "e1: The changed send label is missing from the empty draft."
        : "Unsupported behavior claim.";
      select(f.file);
      api.parse
        .mockResolvedValueOnce(completed({ changes }))
        .mockImplementationOnce((request: { input: string }) => {
          const review = JSON.parse(request.input);
          expect(review.draft.changes).toEqual(changes);
          expect(review.evidence).toContainEqual(labelEvidence(f.file, { id: "e1" }));
          return completed({ approved: false, problems: [correction] });
        })
        .mockImplementationOnce((request: { input: string }) => {
          expect(JSON.parse(request.input).corrections).toEqual([correction]);
          return completed({ changes: [claim] });
        })
        .mockResolvedValueOnce(completed({ approved, problems: approved ? [] : [correction] }));

      if (approved) {
        const saved = await generateMobileReleaseNotes(f);
        expect(saved.entries[0]?.claims).toEqual([claim]);
        expect(renderMobileReleaseNotes(renderOptions(f))).toBe(`- ${claim.text}`);
      } else {
        await expect(generateMobileReleaseNotes(f)).rejects.toThrow(
          "Could not validate ios release notes",
        );
        expect(fs.existsSync(f.outputPath)).toBe(false);
      }
      expect(api.parse).toHaveBeenCalledTimes(5);
    },
  );
});
