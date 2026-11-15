import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { registerSkillsCli } from "./skills-cli.js";
import { verification } from "./skills-cli.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const mocks = await vi.hoisted(async () => {
  const { runtimeFixture } = await import("./skills-cli.test-support.js");
  return {
    ...runtimeFixture(true),
    workspaceDir: "",
    verify: vi.fn(),
    card: vi.fn(),
    noopAsync: vi.fn(),
  };
});

vi.mock("../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime.js")>()),
  defaultRuntime: mocks.runtime,
}));

// mock-isolation: Record CLI exit status without terminating the test worker.
vi.mock("./one-shot-exit.js", () => ({
  exitCliAfterOutput: (runtime: typeof mocks.runtime, exitCode: number) => runtime.exit(exitCode),
}));

// mock-isolation: Resolve the real workspace owner from an isolated fixture roster.
vi.mock("../config/config.js", () => {
  const config = () => ({ agents: { entries: { main: { workspace: mocks.workspaceDir } } } });
  return {
    getRuntimeConfig: config,
    loadConfig: config,
    captureRuntimeConfigAsyncReader: () => async () => config(),
  };
});

vi.mock("../infra/clawhub-skills.js", () => ({
  CLAWHUB_SKILLS_SH_REF_PREFIX: "skills-sh:",
  CLAWHUB_SKILLS_SH_TRUST_LABEL: "Not scanned by ClawHub",
  CLAWHUB_SKILLS_SH_TRUST_STATE: "not-scanned-by-clawhub",
  fetchClawHubSkillCard: mocks.card,
  fetchClawHubSkillDetail: mocks.noopAsync,
  fetchClawHubSkillVerification: mocks.verify,
  searchClawHubSkills: mocks.noopAsync,
}));

vi.mock("../infra/clawhub-artifacts.js", () => ({
  downloadClawHubSkillArchive: mocks.noopAsync,
}));

vi.mock("../infra/clawhub-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/clawhub-client.js")>()),
  resolveClawHubBaseUrl: (baseUrl?: string) =>
    (baseUrl ?? "https://clawhub.ai").replace(/\/+$/, ""),
}));

const { ClawHubRequestError } = await import("../infra/clawhub-client.js");

describe("skills verify CLI", () => {
  beforeEach(() => {
    mocks.stdout.length = 0;
    mocks.errors.length = 0;
    mocks.workspaceDir = tempDirs.make("openclaw-skill-verify-cli-");
    mocks.verify.mockReset();
    mocks.card.mockReset();
    vi.clearAllMocks();
  });

  async function runCommand(...argv: string[]) {
    const program = new Command().exitOverride();
    await registerSkillsCli(program);
    await program.parseAsync(["skills", "verify", ...argv], { from: "user" });
  }

  function payload(): {
    ok?: boolean;
    openclaw?: { trust?: { state?: string; label?: string }; verifiedSourceUrl?: string };
    artifact?: unknown;
  } {
    return JSON.parse(mocks.stdout.at(-1) ?? "{}");
  }
  function expectSuccess() {
    expect(mocks.runtime.exit).not.toHaveBeenCalled();
    expect(mocks.errors).toStrictEqual([]);
  }
  function expectVerification(options: Record<string, unknown>) {
    expect(mocks.verify).toHaveBeenCalledWith({
      version: undefined,
      tag: undefined,
      baseUrl: "https://private.example.com/clawhub",
      ...options,
    });
  }

  async function writeInstalledSkill(slug: string, requestedReference?: string) {
    const skillDir = path.join(mocks.workspaceDir, "skills", slug);
    const metadata = {
      version: 1,
      registry: "https://private.example.com/clawhub",
      slug,
      installedVersion: requestedReference ? "a".repeat(40) : "1.2.3",
      installedAt: 123,
      ...(requestedReference ? { requestedReference, trustState: "not-scanned-by-clawhub" } : {}),
    };
    await fs.mkdir(path.join(skillDir, ".clawhub"), { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), `# ${slug}\n`);
    await fs.writeFile(path.join(skillDir, ".clawhub", "origin.json"), JSON.stringify(metadata));
    const lockDir = path.join(mocks.workspaceDir, ".clawhub");
    const lockEntry = { ...metadata, version: metadata.installedVersion };
    const lock = { version: 1, skills: { [slug]: lockEntry } };
    await fs.mkdir(lockDir, { recursive: true });
    await fs.writeFile(path.join(lockDir, "lock.json"), JSON.stringify(lock));
    return skillDir;
  }

  it("verifies an installed skills.sh skill by its exact reference without a version selector", async () => {
    const requestedReference = "skills-sh:patrick-erichsen/skills/html";
    await writeInstalledSkill("html", requestedReference);
    mocks.verify.mockResolvedValueOnce(verification({ decision: "unscanned" }));
    await expect(runCommand(requestedReference)).rejects.toThrow("__exit__:1");
    expectVerification({ slug: "html", requestedReference });
    expect(payload().openclaw?.trust).toEqual({
      state: "not-scanned-by-clawhub",
      label: "Not scanned by ClawHub",
    });
  });

  it.each([
    [
      ["skills-sh:owner-b/repo-b/html", "--json"],
      'Skill "html" is not tracked from skills-sh:owner-b/repo-b/html.',
      "skills-sh:owner-a/repo-a/html",
    ],
    [["weather", "--agent", " "], "--agent must not be blank", undefined],
  ])("reports invalid target %s as JSON before verification", async (args, message, installed) => {
    if (installed) {
      await writeInstalledSkill("html", installed);
    }
    await expect(runCommand(...args)).rejects.toThrow("__exit__:1");
    expect(payload()).toEqual({ ok: false, error: { type: "cli_error", message } });
    expect(mocks.errors).toStrictEqual([]);
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("maps registry failures to a human domain error without leaking upstream details", async () => {
    mocks.verify.mockRejectedValueOnce(
      new ClawHubRequestError({
        path: "/api/v1/skills/nonexistent-skill-xyz/verify",
        status: 404,
        body: "remote-controlled not-found detail",
      }),
    );
    await expect(runCommand("nonexistent-skill-xyz", "--card")).rejects.toThrow("__exit__:1");
    expect(mocks.stdout).toStrictEqual([]);
    expect(mocks.errors).toStrictEqual([
      'Skill "nonexistent-skill-xyz" not found on ClawHub. Run `openclaw skills search nonexistent-skill-xyz` to find the right skill reference.',
    ]);
    expect(mocks.errors.join("\n")).not.toMatch(/\/api\/v1\/|\(404\)|remote-controlled/u);
  });

  it("does not reject an installed bundle just because ClawHub generated skill-card.md", async () => {
    const skillDir = await writeInstalledSkill("agentreceipt");
    await fs.writeFile(path.join(skillDir, "skill-card.md"), "# Generated Skill Card\n");
    mocks.verify.mockResolvedValueOnce(
      verification({
        provenance: {
          source: "server-resolved-github-import",
          repo: "openclaw/skills",
          commit: "0123456789abcdef0123456789abcdef01234567",
          path: "agentreceipt",
        },
        version: { version: "1.2.3" },
        artifact: {
          sourceFingerprint: "source-without-card",
          bundleFingerprints: ["bundle-with-card"],
        },
      }),
    );

    await runCommand("agentreceipt", "--json");
    expectVerification({ slug: "agentreceipt", version: "1.2.3" });
    const result = payload();
    expect(result.ok).toBe(true);
    expect(result.openclaw).toMatchObject({
      verifiedSourceUrl:
        "https://github.com/openclaw/skills/tree/0123456789abcdef0123456789abcdef01234567/agentreceipt",
    });
    expect(result.artifact).toEqual({
      sourceFingerprint: "source-without-card",
      bundleFingerprints: ["bundle-with-card"],
    });
    expectSuccess();
  });

  it.each([false, true])("prints owner-qualified cards unless cancelled (%s)", async (cancel) => {
    const scope = new AsyncWorkScope();
    mocks.verify.mockResolvedValueOnce(
      verification({
        card: { available: true, url: "https://cards.example.test/generated/weather.md" },
      }),
    );
    mocks.card.mockImplementationOnce(async () => {
      if (cancel) {
        scope.beginClose();
      }
      return "# Weather\n";
    });
    await scope.run(() => runCommand("@demo-owner/weather", "--tag", "latest", "--card"));
    expectVerification({
      slug: "weather",
      ownerHandle: "demo-owner",
      tag: "latest",
      baseUrl: "https://clawhub.ai",
      signal: scope.signal,
    });
    expect(mocks.card).toHaveBeenCalledWith({
      url: "https://cards.example.test/generated/weather.md",
      baseUrl: "https://clawhub.ai",
      signal: scope.signal,
    });
    if (cancel) {
      expect(mocks.stdout).toStrictEqual([]);
    } else {
      expect(mocks.stdout.at(-1)).toBe("# Weather");
    }
    expectSuccess();
  });

  it("does not promote unavailable provenance URLs in verify JSON", async () => {
    mocks.verify.mockResolvedValueOnce(
      verification({
        provenance: { source: "unavailable", url: "https://github.com/o/r/tree/unverified/s" },
      }),
    );

    await runCommand("agentreceipt");

    expect(payload().openclaw?.verifiedSourceUrl).toBeUndefined();
    expectSuccess();
  });
});
