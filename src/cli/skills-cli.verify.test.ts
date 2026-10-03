import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawHubSkillVerificationResponse } from "../infra/clawhub-skills.js";
import { registerSkillsCli } from "./skills-cli.js";

const mocks = vi.hoisted(() => {
  const runtimeStdout: string[] = [];
  const runtimeErrors: string[] = [];
  const defaultRuntime = {
    log: vi.fn(),
    error: vi.fn((value: unknown) => {
      runtimeErrors.push(String(value));
    }),
    writeStdout: vi.fn((value: string) => {
      runtimeStdout.push(value.endsWith("\n") ? value.slice(0, -1) : value);
    }),
    writeJson: vi.fn((value: unknown, space = 2) => {
      runtimeStdout.push(JSON.stringify(value, null, space > 0 ? space : undefined));
    }),
    exit: vi.fn((code: number) => {
      throw new Error(`__exit__:${code}`);
    }),
  };
  return {
    defaultRuntime,
    runtimeStdout,
    runtimeErrors,
    workspaceDir: "",
    verify: vi.fn(),
    card: vi.fn(),
    noopAsync: vi.fn(),
  };
});

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.defaultRuntime,
}));

vi.mock("./one-shot-exit.js", () => ({
  exitCliAfterOutput: (runtime: typeof mocks.defaultRuntime, exitCode: number) =>
    runtime.exit(exitCode),
}));

vi.mock("../utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils.js")>()),
  CONFIG_DIR: "/tmp/openclaw-config",
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => ({}),
  loadConfig: () => ({}),
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveConfiguredAgentId: (_config: unknown, agentId: string) => agentId,
  resolveAgentIdByWorkspacePath: () => undefined,
  resolveDefaultAgentId: () => "main",
  resolveAgentWorkspaceDir: () => mocks.workspaceDir,
}));

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
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-verify-cli-"));
    mocks.runtimeStdout.length = 0;
    mocks.runtimeErrors.length = 0;
    mocks.workspaceDir = workspaceDir;
    mocks.verify.mockReset();
    mocks.card.mockReset();
    for (const mock of Object.values(mocks.defaultRuntime)) {
      mock.mockClear();
    }
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  async function runCommand(argv: string[]) {
    const program = new Command();
    program.exitOverride();
    registerSkillsCli(program);
    await program.parseAsync(argv, { from: "user" });
  }

  function mockVerification(overrides: Partial<ClawHubSkillVerificationResponse> = {}) {
    mocks.verify.mockResolvedValueOnce({
      schema: "clawhub.skill.verify.v1",
      ok: true,
      decision: "pass",
      reasons: [],
      skill: { slug: "agentreceipt" },
      publisher: { handle: "openclaw" },
      version: { version: "1.0.0" },
      card: { available: true },
      artifact: { sourceFingerprint: "source-fp" },
      provenance: null,
      security: { status: "clean" },
      signature: { status: "unsigned" },
      ...overrides,
    });
  }

  async function writeInstalledSkill(slug: string, requestedReference?: string) {
    const skillDir = path.join(workspaceDir, "skills", slug);
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
    await fs.mkdir(path.join(workspaceDir, ".clawhub"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, ".clawhub", "lock.json"),
      JSON.stringify({
        version: 1,
        skills: { [slug]: { ...metadata, version: metadata.installedVersion } },
      }),
    );
    return skillDir;
  }

  it("verifies an installed skills.sh skill by its exact reference without a version selector", async () => {
    const requestedReference = "skills-sh:patrick-erichsen/skills/html";
    const trustState = "not-scanned-by-clawhub";
    await writeInstalledSkill("html", requestedReference);
    mockVerification({
      decision: "unscanned",
      reasons: ["security.not_scanned_by_clawhub"],
      skill: { slug: "html" },
      publisher: { handle: "patrick-erichsen" },
      version: { version: "a".repeat(40) },
      security: { status: "not-scanned", passed: false },
    });

    await expect(runCommand(["skills", "verify", requestedReference])).rejects.toThrow(
      "__exit__:1",
    );

    expect(mocks.verify).toHaveBeenCalledWith({
      slug: "html",
      requestedReference,
      version: undefined,
      tag: undefined,
      baseUrl: "https://private.example.com/clawhub",
    });
    const payload = JSON.parse(mocks.runtimeStdout.at(-1) ?? "{}") as {
      openclaw?: { trust?: { state?: string; label?: string } };
    };
    expect(payload.openclaw?.trust).toEqual({
      state: trustState,
      label: "Not scanned by ClawHub",
    });
  });

  it("rejects an installed skills.sh reference from another owner in JSON", async () => {
    await writeInstalledSkill("html", "skills-sh:owner-a/repo-a/html");
    await expect(
      runCommand(["skills", "verify", "skills-sh:owner-b/repo-b/html", "--json"]),
    ).rejects.toThrow("__exit__:1");
    expect(JSON.parse(mocks.runtimeStdout.at(-1) ?? "{}")).toEqual({
      ok: false,
      error: {
        type: "cli_error",
        message: 'Skill "html" is not tracked from skills-sh:owner-b/repo-b/html.',
      },
    });
    expect(mocks.runtimeErrors).toStrictEqual([]);
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("reports workspace resolution exceptions as JSON", async () => {
    await expect(runCommand(["skills", "verify", "weather", "--agent", " "])).rejects.toThrow(
      "__exit__:1",
    );
    expect(JSON.parse(mocks.runtimeStdout.at(-1) ?? "{}")).toEqual({
      ok: false,
      error: { type: "cli_error", message: "--agent must not be blank" },
    });
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("reports runtime errors in JSON by default", async () => {
    mocks.verify.mockRejectedValueOnce(new Error("ClawHub verification unavailable"));
    await expect(runCommand(["skills", "verify", "@demo-owner/weather"])).rejects.toThrow(
      "__exit__:1",
    );
    expect(JSON.parse(mocks.runtimeStdout.at(-1) ?? "{}")).toEqual({
      ok: false,
      error: { type: "cli_error", message: "ClawHub verification unavailable" },
    });
    expect(mocks.runtimeErrors).toStrictEqual([]);
  });

  it("maps registry failures to a human domain error without leaking upstream details", async () => {
    mocks.verify.mockRejectedValueOnce(
      new ClawHubRequestError({
        path: "/api/v1/skills/nonexistent-skill-xyz/verify",
        status: 404,
        body: "remote-controlled not-found detail",
      }),
    );
    await expect(
      runCommand(["skills", "verify", "nonexistent-skill-xyz", "--card"]),
    ).rejects.toThrow("__exit__:1");
    expect(mocks.runtimeStdout).toStrictEqual([]);
    expect(mocks.runtimeErrors).toStrictEqual([
      'Skill "nonexistent-skill-xyz" not found on ClawHub. Run `openclaw skills search nonexistent-skill-xyz` to find the right skill reference.',
    ]);
    expect(mocks.runtimeErrors.join("\n")).not.toMatch(/\/api\/v1\/|\(404\)|remote-controlled/u);
  });

  it("does not reject an installed bundle just because ClawHub generated skill-card.md", async () => {
    const skillDir = await writeInstalledSkill("agentreceipt");
    await fs.writeFile(
      path.join(skillDir, "skill-card.md"),
      "# Generated Skill Card\nClawHub bundle metadata.\n",
    );
    mockVerification({
      provenance: {
        source: "server-resolved-github-import",
        kind: "github",
        url: "https://github.com/openclaw/skills/tree/main/agentreceipt",
        repo: "openclaw/skills",
        ref: "main",
        commit: "0123456789abcdef0123456789abcdef01234567",
        path: "agentreceipt",
      },
      version: { version: "1.2.3" },
      artifact: {
        sourceFingerprint: "publisher-source-fingerprint-without-generated-card",
        bundleFingerprints: ["generated-bundle-fingerprint-with-skill-card"],
      },
    });

    await runCommand(["skills", "verify", "agentreceipt", "--json"]);

    expect(mocks.verify).toHaveBeenCalledWith({
      slug: "agentreceipt",
      version: "1.2.3",
      tag: undefined,
      baseUrl: "https://private.example.com/clawhub",
    });
    const payload = JSON.parse(mocks.runtimeStdout.at(-1) ?? "{}") as Record<string, unknown>;
    expect(payload.ok).toBe(true);
    expect(payload.openclaw).toMatchObject({
      verifiedSourceUrl:
        "https://github.com/openclaw/skills/tree/0123456789abcdef0123456789abcdef01234567/agentreceipt",
    });
    expect(payload.artifact).toEqual({
      sourceFingerprint: "publisher-source-fingerprint-without-generated-card",
      bundleFingerprints: ["generated-bundle-fingerprint-with-skill-card"],
    });
    expect(mocks.defaultRuntime.exit).not.toHaveBeenCalled();
    expect(mocks.runtimeErrors).toStrictEqual([]);
  });

  it("prints cards for owner-qualified tag verification", async () => {
    mockVerification({
      skill: { slug: "weather" },
      publisher: { handle: "demo-owner" },
      version: { version: "2.0.0" },
      card: {
        available: true,
        url: "https://cards.example.test/generated/weather.md",
      },
    });
    mocks.card.mockResolvedValueOnce("# Weather\n");

    await runCommand(["skills", "verify", "@demo-owner/weather", "--tag", "latest", "--card"]);

    expect(mocks.verify).toHaveBeenCalledWith({
      slug: "weather",
      ownerHandle: "demo-owner",
      version: undefined,
      tag: "latest",
      baseUrl: "https://clawhub.ai",
    });
    expect(mocks.card).toHaveBeenCalledWith({
      url: "https://cards.example.test/generated/weather.md",
      baseUrl: "https://clawhub.ai",
    });
    expect(mocks.runtimeStdout.at(-1)).toBe("# Weather");
    expect(mocks.defaultRuntime.exit).not.toHaveBeenCalled();
    expect(mocks.runtimeErrors).toStrictEqual([]);
  });

  it("does not promote unavailable provenance URLs in verify JSON", async () => {
    mockVerification({
      provenance: {
        source: "unavailable",
        url: "https://github.com/openclaw/skills/tree/unverified/agentreceipt",
      },
    });

    await runCommand(["skills", "verify", "agentreceipt"]);

    const payload = JSON.parse(mocks.runtimeStdout.at(-1) ?? "{}") as {
      openclaw?: { verifiedSourceUrl?: string };
    };
    expect(payload.openclaw?.verifiedSourceUrl).toBeUndefined();
    expect(mocks.defaultRuntime.exit).not.toHaveBeenCalled();
    expect(mocks.runtimeErrors).toStrictEqual([]);
  });
});
