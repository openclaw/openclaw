import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { fetchWithSsrFGuard } from "../../infra/net/fetch-guard.js";
import { syncGitHubIdentity } from "../../state/user-profile-writes.worker.js";
import { useStateDatabaseTempDirs } from "../../test-utils/state-database-temp-dirs.js";
import { readSkillLibraryTree } from "./bundle.js";
import { importSkillLibrary } from "./import.js";
import { listSkillLibrary, readSkillLibrary } from "./service.js";
import type { SkillLibraryAuthority } from "./store.js";

vi.mock("../../infra/net/fetch-guard.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/net/fetch-guard.js")>()),
  fetchWithSsrFGuard: vi.fn(),
}));

const dirs = useStateDatabaseTempDirs();
const url = "https://github.com/example/skills/tree/main/guide";
const commit = "a".repeat(40);
const content =
  "---\nname: Guide\ndescription: Synthetic import fixture.\n---\nRead references/note.txt.\n";
const params = { slug: "guide", source: { kind: "github" as const, url } };
beforeEach(() => vi.clearAllMocks());

function fixture(scopes = ["operator.read", "operator.write"]) {
  const root = dirs.make("skill-import-policy-");
  const options = { env: { OPENCLAW_STATE_DIR: root } };
  const authenticationAlias = { kind: "email", email: "writer@example.test" } as const;
  const identity = { accountId: 42, login: "Library-Writer" };
  const profile = syncGitHubIdentity({ identity, authenticationAlias }, options);
  const config: OpenClawConfig = {
    gateway: {
      roles: {
        default: "reader",
        assignments: { byGithubLogin: { "library-writer": "writer" } },
        definitions: {
          reader: { sessions: { others: "none" }, agents: [], scopes: ["operator.read"] },
          writer: {
            sessions: { others: "none" },
            agents: "*",
            scopes: ["operator.read", "operator.write"],
          },
        },
      },
    },
  };
  const authority: SkillLibraryAuthority = {
    profileId: profile.id,
    scopes,
    getConfig: () => config,
    assertCurrent() {},
  };
  const revoke = () =>
    syncGitHubIdentity(
      { identity: { ...identity, login: "Revoked-Writer" }, authenticationAlias },
      options,
    );
  return { root, options, authority, config, revoke };
}

async function serve(onResponse?: (archive: boolean) => void) {
  const zip = new JSZip();
  zip.file("skills/guide/SKILL.md", content);
  zip.file("skills/guide/references/note.txt", "synthetic reference");
  const bytes = await zip.generateAsync({ type: "nodebuffer" });
  const requests: string[] = [];
  vi.mocked(fetchWithSsrFGuard).mockImplementation(async (options) => {
    options.beforeRequest?.();
    // Count initiation, not transport preparation rejected by the live authority guard.
    requests.push(options.url);
    const archive = options.url.startsWith("https://codeload.github.com/");
    onResponse?.(archive);
    return {
      response: new Response(archive ? new Uint8Array(bytes) : commit),
      release: async () => {},
      finalUrl: options.url,
    };
  });
  return requests;
}

it("passes pinned GitHub provenance to the real save policy and publishes only allowed sources", async () => {
  const f = fixture();
  await fs.chmod(f.root, 0o700);
  const policyPath = path.join(f.root, "policy.cjs");
  const receiptPath = path.join(f.root, "policy-input.json");
  await fs.writeFile(
    policyPath,
    `const fs = require("node:fs");
let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  fs.writeFileSync(${JSON.stringify(receiptPath)}, JSON.stringify(request));
  const blocked = process.env.ALLOW_GIT !== "1" && (request.source.kind === "git" || request.source.authority === "third-party");
  process.stdout.write(JSON.stringify({ protocolVersion: 1, decision: blocked ? "block" : "allow", reason: "Git sources denied" }));
});
`,
    { mode: 0o700 },
  );
  const policyCommand = await fs.realpath(process.execPath);
  const policyExec = {
    source: "exec" as const,
    command: policyCommand,
    args: [policyPath],
    trustedDirs: [f.root, path.dirname(policyCommand)],
    timeoutMs: 5000,
    env: { ALLOW_GIT: "0" },
  };
  f.config.security = { installPolicy: { enabled: true, exec: policyExec } };
  await serve();
  await expect(importSkillLibrary(f.authority, params, f.options)).rejects.toMatchObject({
    code: "POLICY_BLOCKED",
    message: expect.stringContaining("Git sources denied"),
  });
  expect(JSON.parse(await fs.readFile(receiptPath, "utf8"))).toMatchObject({
    source: { kind: "git", authority: "third-party", mutable: false, network: true },
    origin: { type: "git", spec: "https://github.com/example/skills", commit, ref: "main" },
  });
  expect((await listSkillLibrary(f.authority, {}, f.options)).entries).toEqual([]);
  expect(await readSkillLibraryTree(path.join(f.root, "skill-library"))).toEqual([]);
  policyExec.env.ALLOW_GIT = "1";
  const result = await importSkillLibrary(f.authority, params, f.options);
  expect(
    (await readSkillLibrary(f.authority, result.entry.skillId, undefined, f.options)).content,
  ).toBe(content);
});

it.each(["read-only", "revoked"])("rejects %s profiles before GitHub requests", async (kind) => {
  const f = fixture(kind === "read-only" ? ["operator.read"] : undefined);
  if (kind === "revoked") {
    f.revoke();
  }
  await serve();
  await expect(importSkillLibrary(f.authority, params, f.options)).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  expect(fetchWithSsrFGuard).not.toHaveBeenCalled();
});

it.each([false, true])(
  "stops after profile revocation during archive response: %s",
  async (archive) => {
    const f = fixture();
    const requests = await serve((isArchive) => {
      if (isArchive === archive) {
        f.revoke();
      }
    });
    await expect(importSkillLibrary(f.authority, params, f.options)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(requests).toHaveLength(archive ? 2 : 1);
    expect((await listSkillLibrary(f.authority, {}, f.options)).entries).toEqual([]);
  },
);
