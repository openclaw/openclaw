// Session path helper tests pin default store path contracts used by CLI commands.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as boundaryPath from "../../infra/boundary-path.js";
import { resolveSessionFilePathCoreAsync } from "./paths-async.js";
import {
  resolveSessionFilePathCore,
  resolveSessionStorePathCore,
  SessionStoreAgentIdRequiredError,
} from "./paths.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveSessionFilePath cross-root reroot", () => {
  it.skipIf(process.platform === "win32")(
    "preserves parent normalization inside an expanded symlink target",
    async () => {
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-link-parent-")));
      tempDirs.push(root);
      const sessionsDir = path.join(root, "agents", "main", "sessions");
      const siblingDir = path.join(root, "agents", "worker", "sessions");
      fs.mkdirSync(sessionsDir, { recursive: true });
      fs.mkdirSync(path.join(siblingDir, "child"), { recursive: true });
      const expected = path.join(sessionsDir, "record.jsonl");
      fs.writeFileSync(expected, "main\n");
      fs.writeFileSync(path.join(siblingDir, "record.jsonl"), "worker\n");
      fs.symlinkSync(path.join(siblingDir, "child"), path.join(sessionsDir, "link"), "dir");
      const alias = path.join(sessionsDir, "alias.jsonl");
      fs.symlinkSync("link/../record.jsonl", alias);
      const entry = { sessionFile: alias };
      const options = { sessionsDir, agentId: "worker" };

      expect(resolveSessionFilePathCore("fallback", entry, options)).toBe(expected);
      await expect(resolveSessionFilePathCoreAsync("fallback", entry, options)).resolves.toBe(
        expected,
      );
    },
  );
  it.skipIf(process.platform === "win32")(
    "preserves lexical parent normalization before following links",
    async () => {
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-path-parent-")));
      tempDirs.push(root);
      const sessionsDir = path.join(root, "sessions");
      const outside = path.join(root, "outside");
      fs.mkdirSync(sessionsDir);
      fs.mkdirSync(path.join(outside, "child"), { recursive: true });
      fs.writeFileSync(path.join(sessionsDir, "record.jsonl"), "{}\n");
      fs.writeFileSync(path.join(outside, "record.jsonl"), "{}\n");
      fs.symlinkSync(path.join(outside, "child"), path.join(sessionsDir, "alias"), "dir");
      const entry = { sessionFile: `${sessionsDir}/alias/../record.jsonl` };
      const expected = path.join(sessionsDir, "record.jsonl");
      expect(resolveSessionFilePathCore("fallback", entry, { sessionsDir })).toBe(expected);
      await expect(
        resolveSessionFilePathCoreAsync("fallback", entry, { sessionsDir }),
      ).resolves.toBe(expected);
    },
  );
  it.skipIf(process.platform === "win32")(
    "resolves a sibling transcript once per call and observes changed symlinks",
    async () => {
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sibling-")));
      tempDirs.push(root);
      const sessionsDir = path.join(root, "agents", "main", "sessions");
      const siblingDir = path.join(root, "agents", "worker", "sessions");
      fs.mkdirSync(sessionsDir, { recursive: true });
      fs.mkdirSync(siblingDir, { recursive: true });
      const transcript = path.join(siblingDir, "sess-1.jsonl");
      const outside = path.join(root, "outside.jsonl");
      fs.writeFileSync(transcript, "{}\n");
      fs.writeFileSync(outside, "{}\n");
      const alias = path.join(sessionsDir, "alias.jsonl");
      fs.symlinkSync(transcript, alias);
      const realpath = vi.spyOn(boundaryPath, "safeRealpathSync");
      const resolve = () =>
        resolveSessionFilePathCore(
          "sess-1",
          { sessionFile: alias },
          { sessionsDir, agentId: "worker" },
        );

      expect(resolve()).toBe(transcript);
      expect(
        realpath.mock.calls.filter(([file]) => file === alias || file === transcript),
      ).toHaveLength(1);

      await expect(
        resolveSessionFilePathCoreAsync(
          "sess-1",
          { sessionFile: alias },
          { sessionsDir, agentId: "worker" },
        ),
      ).resolves.toBe(transcript);

      fs.unlinkSync(alias);
      fs.symlinkSync(outside, alias);
      expect(resolve()).toBe(path.join(sessionsDir, "sess-1.jsonl"));
      await expect(
        resolveSessionFilePathCoreAsync(
          "sess-1",
          { sessionFile: alias },
          { sessionsDir, agentId: "worker" },
        ),
      ).resolves.toBe(path.join(sessionsDir, "sess-1.jsonl"));
    },
  );

  it("re-roots foreign-root absolute paths when the file exists in the current sessions dir", async () => {
    // Restored backups and moved state dirs persist absolute sessionFile
    // paths from the old root; migration must find the local copy.
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-reroot-")));
    tempDirs.push(root);
    const sessionsDir = path.join(root, "agents", "main", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, "sess-1.jsonl"), "{}\n", "utf8");
    const foreign = "/nonexistent-old-root/.openclaw/agents/main/sessions/sess-1.jsonl";

    const resolved = resolveSessionFilePathCore(
      "sess-1",
      { sessionFile: foreign },
      { sessionsDir, agentId: "main" },
    );

    expect(resolved).toBe(path.join(sessionsDir, "sess-1.jsonl"));
    await expect(
      resolveSessionFilePathCoreAsync(
        "sess-1",
        { sessionFile: foreign },
        { sessionsDir, agentId: "main" },
      ),
    ).resolves.toBe(resolved);
  });

  it("keeps foreign-root absolute paths when no local copy exists", async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-reroot-keep-")));
    tempDirs.push(root);
    const sessionsDir = path.join(root, "agents", "main", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    const foreign = "/nonexistent-old-root/.openclaw/agents/main/sessions/sess-2.jsonl";

    const resolved = resolveSessionFilePathCore(
      "sess-2",
      { sessionFile: foreign },
      { sessionsDir, agentId: "main" },
    );

    expect(resolved).toBe(foreign);
    await expect(
      resolveSessionFilePathCoreAsync(
        "sess-2",
        { sessionFile: foreign },
        { sessionsDir, agentId: "main" },
      ),
    ).resolves.toBe(resolved);
  });
});

describe("resolveStorePath", () => {
  it.each([".openclaw", "custom-state"])(
    "anchors a relative session.store to %s when the Gateway cwd is home",
    (stateDirectory) => {
      const home = path.join(path.parse(process.cwd()).root, "gateway-home");
      const stateDir = path.join(home, stateDirectory);
      const cfg = { session: { store: "agents/{agentId}/sessions/sessions.json" } };
      const env = { HOME: home, OPENCLAW_STATE_DIR: stateDir };
      vi.spyOn(process, "cwd").mockReturnValue(home);

      expect(resolveSessionStorePathCore(cfg.session.store, { agentId: "main", env })).toBe(
        path.join(stateDir, "agents", "main", "sessions", "sessions.json"),
      );
    },
  );

  it("resolves a fixed literal path without an agent owner", () => {
    const fixed = path.join(path.parse(process.cwd()).root, "shared", "sessions.json");
    expect(resolveSessionStorePathCore(fixed)).toBe(path.resolve(fixed));
  });

  it("throws a typed error when an agent template has no owner", () => {
    expect(() => resolveSessionStorePathCore("/state/agents/{agentId}/sessions.json")).toThrow(
      SessionStoreAgentIdRequiredError,
    );
  });

  it.each(["work", " WORK ", "work/team"])(
    "joins the default store path for %s only once",
    (agentId) => {
      const stateDir = path.join(path.parse(process.cwd()).root, "openclaw-test-state");
      const env = {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
      };
      const expected = path.join(
        stateDir,
        "agents",
        agentId.includes("/") ? "work-team" : "work",
        "sessions",
        "sessions.json",
      );
      const join = vi.spyOn(path, "join");

      expect(resolveSessionStorePathCore(undefined, { agentId, env })).toBe(expected);
      expect(resolveSessionStorePathCore("", { agentId, env })).toBe(expected);
      expect(join).toHaveBeenCalledTimes(2);
    },
  );
});
