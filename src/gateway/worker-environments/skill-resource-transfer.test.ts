import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { readCodeModeSkill, resolveCodeModeSkills } from "../../agents/code-mode-skills.js";
import { registerAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import { NodeWorkerWorkspaceRuntime } from "../../node-host/node-worker-workspace.js";
import { formatSkillsCompactForPrompt } from "../../skills/loading/skill-contract.js";
import { loadWorkspaceSkills } from "../../skills/loading/workspace-skill-loader.js";
import { buildSkillSnapshot } from "../../skills/loading/workspace-skill-prompt.js";
import { readWorkspaceSkillSources } from "../../skills/loading/workspace-skill-source-reader.js";
import { resolveWorkspaceSkillSourcePlan } from "../../skills/loading/workspace-skill-sources.js";
import { applySkillEnvOverridesFromSnapshot } from "../../skills/runtime/env-overrides.js";
import {
  readSkillResourceFiles,
  resolveExplicitSkillResource,
} from "../../skills/runtime/resources.js";
import { transferSkillResources } from "./skill-resource-transfer.js";
import {
  createNodeCarrier,
  NODE_WORKER_WORKSPACE_STDIN_MAX_BYTES,
} from "./skill-resource-transfer.test-support.js";
import type { WorkerWorkspaceTunnelHandle } from "./tunnel-contract.js";
import { captureWorkspaceManifest } from "./workspace-manifest-worker.js";
import { WORKER_ATTACHMENT_DIRECTORY_PREFIX } from "./workspace-path-exclusions.js";

const temps = useAutoCleanupTempDirTracker(afterEach);
const tunnel: Pick<WorkerWorkspaceTunnelHandle, "runWorkspaceCommand"> = {
  runWorkspaceCommand: async (command) => {
    command.assertCurrent?.();
    return new Promise((resolve, reject) => {
      const child = spawn(command.argv[0]!, command.argv.slice(1), {
        stdio: "pipe",
        signal: command.signal,
      });
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (bytes) => {
        stdout += bytes;
      });
      child.stderr.on("data", (bytes) => {
        stderr += bytes;
      });
      child.on("error", reject);
      child.on("close", (code) =>
        resolve({ stdout, stderr, code, termination: "exit", signal: null, killed: false }),
      );
      child.stdin.end(command.input);
    });
  },
};

function trackAllocation<T extends typeof tunnel & { workspace: string }>(carrier: T) {
  let allocated: string | undefined;
  return {
    ...carrier,
    get allocated() {
      return allocated;
    },
    runWorkspaceCommand: async (
      command: Parameters<WorkerWorkspaceTunnelHandle["runWorkspaceCommand"]>[0],
    ) => {
      const result = await carrier.runWorkspaceCommand(command);
      if (command.input) {
        const operation = JSON.parse(command.input);
        if (operation.op === "init") {
          allocated = path.join(carrier.workspace, operation.directory);
        }
      }
      return result;
    },
  };
}

async function createCarrier(kind = "ssh") {
  return trackAllocation(
    kind === "node"
      ? await createNodeCarrier(temps.make("skill-resource-node-"))
      : { ...tunnel, workspace: await fs.realpath(temps.make("skill-resource-ssh-")) },
  );
}

type TransferOptions = Parameters<typeof transferSkillResources>[0];
type Carrier = Awaited<ReturnType<typeof createCarrier>>;
function transfer(
  carrier: Carrier,
  snapshot?: TransferOptions["snapshot"],
  options: Partial<TransferOptions> = {},
) {
  return transferSkillResources({
    snapshot,
    tunnel: carrier,
    remoteWorkspaceDir: carrier.workspace,
    assertCurrent: () => {},
    ...options,
  });
}

const remove = (directory: string) => fs.rm(directory, { recursive: true, force: true });
const expectMissing = (file: string) =>
  expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
const readText = (directory: string, file: string) =>
  fs.readFile(path.join(directory, file), "utf8");
const readBinary = (directory: string) => fs.readFile(path.join(directory, "data.bin"));

async function withResources(
  resources: Awaited<ReturnType<typeof transferSkillResources>>,
  check: (resources: NonNullable<typeof resources>, remote: string) => Promise<void>,
) {
  expect(resources).toBeDefined();
  try {
    await check(resources!, resources!.mounts[0]!.containerPath);
  } finally {
    await resources?.cleanup();
  }
}

async function createSource(binarySize = 150000) {
  const workspace = await fs.realpath(temps.make("remote-skill-source-"));
  const baseDir = path.join(workspace, "skills", "source");
  await fs.mkdir(path.join(baseDir, "scripts"), { recursive: true });
  const filePath = path.join(baseDir, "SKILL.md");
  await fs.writeFile(
    filePath,
    "---\ndescription: Resource transfer test\n---\n# Resource\nRead data.bin and run scripts/check.sh.\n",
  );
  const binary = Buffer.alloc(binarySize, 129);
  await fs.writeFile(path.join(baseDir, "data.bin"), binary);
  await fs.writeFile(path.join(baseDir, "scripts/check.sh"), "#!/bin/sh\nprintf ready\n", {
    mode: 0o700,
  });
  return {
    workspace,
    filePath,
    binary,
    snapshot: await buildSkillSnapshot(workspace, {
      entries: loadWorkspaceSkills(workspace, { workspaceOnly: true }),
    }),
  };
}

async function createStaleSource(sameNamedNode = false) {
  const source = await createSource();
  const staleBaseDir = path.join(source.workspace, "skills", "stale");
  await fs.mkdir(staleBaseDir, { recursive: true });
  await fs.writeFile(
    path.join(staleBaseDir, "SKILL.md"),
    "---\ndescription: Stale resource\n---\n# Stale\n",
  );
  const snapshot = sameNamedNode
    ? await buildSkillSnapshot(source.workspace, {
        entries: loadWorkspaceSkills(source.workspace, { workspaceOnly: true }),
      })
    : source.snapshot;
  const sourceSkill = snapshot.resolvedSkills?.[0];
  expect(sourceSkill).toBeDefined();
  snapshot.resolvedSkills!.push({
    ...(sameNamedNode ? structuredClone(sourceSkill!) : sourceSkill!),
    name: "stale",
    filePath: path.join(staleBaseDir, "SKILL.md"),
    baseDir: staleBaseDir,
  });
  snapshot.skills.push({
    name: "stale",
    skillKey: "stale",
    ...(!sameNamedNode && { primaryEnv: "STALE_SKILL_API_KEY" }),
  });
  if (sameNamedNode) {
    snapshot.resolvedSkills!.push({
      ...structuredClone(sourceSkill!),
      name: "stale",
      filePath: "node://worker/skills/stale/SKILL.md",
      baseDir: "node://worker/skills/stale",
    });
  } else {
    snapshot.prompt += "\nstale";
  }
  await fs.rm(staleBaseDir, { recursive: true });
  await fs.symlink(path.join(source.workspace, "missing-stale-target"), staleBaseDir, "dir");
  return snapshot;
}

async function expectRejectedResourceRequest(
  carrier: string,
  mutate: (input: string) => string,
  message = "Skill resource transfer failed",
) {
  // Keep malformed field tests below the independent transport-size boundary.
  const { snapshot } = await createSource(16);
  const transport = await createCarrier(carrier);
  let injected = false;
  await expect(
    transfer(transport, snapshot, {
      tunnel: {
        runWorkspaceCommand: async (command) => {
          const operation = JSON.parse(command.input!);
          let dispatched = command;
          if (operation.op === "write" && !injected) {
            dispatched = { ...command, input: mutate(command.input!) };
            injected = true;
          }
          return transport.runWorkspaceCommand(dispatched);
        },
      },
    }),
  ).rejects.toThrow(message);
  expect(injected).toBe(true);
  await expectMissing(transport.allocated!);
}

describe("remote-exec skill resources", () => {
  it.each(["node"])(
    "transfers host bytes rather than stale Gateway bytes over %s",
    async (kind) => {
      const source = await createSource(16);
      const hostRoot = temps.make("skill-resource-host-");
      await fs.cp(source.workspace, hostRoot, { recursive: true });
      const script = "#!/bin/sh\nprintf host-script\n";
      await fs.writeFile(path.join(hostRoot, "skills/source/scripts/check.sh"), script);
      const release = registerAgentWorkspaceAccess(source.workspace, {
        bridge: {
          readFile: async () => {
            throw new Error("Document bridge must not read skill resources");
          },
          writeFile: async () => {
            throw new Error("Unexpected write");
          },
          stat: async () => {
            throw new Error("Unexpected stat");
          },
        },
        loadSkills: async (request) =>
          readWorkspaceSkillSources({
            ...request,
            sourcePlan: resolveWorkspaceSkillSourcePlan(hostRoot, { workspaceOnly: true }),
          }),
        skillResources: {
          readInstructions: (filePath, options) =>
            fs.readFile(path.join(hostRoot, path.relative(source.workspace, filePath)), {
              ...options,
              encoding: "utf8",
            }),
          resolveExplicitSkill: resolveExplicitSkillResource,
          readSkillFiles: (skill, options) =>
            readSkillResourceFiles(
              {
                ...skill,
                baseDir: path.join(hostRoot, path.relative(source.workspace, skill.baseDir)),
              },
              options,
            ),
        },
      });
      const carrier = await createCarrier(kind);
      try {
        await withResources(
          await transfer(carrier, source.snapshot, { workspaceDir: source.workspace }),
          async (_resources, remote) => {
            expect(await readText(remote, "scripts/check.sh")).toBe(script);
          },
        );
      } finally {
        release();
      }
    },
  );

  it.each(["ssh"])("batches small resources within the input budget over %s", async (kind) => {
    const { snapshot, filePath, binary } = await createSource();
    const base = path.dirname(filePath);
    const files = new Map<string, string>([["empty.txt", ""]]);
    for (let index = 0; index < 20; index += 1) {
      files.set(`nested/${index}/résumé.txt`, `resource ${index}\n`);
    }
    for (const [name, content] of files) {
      await fs.mkdir(path.dirname(path.join(base, name)), { recursive: true });
      await fs.writeFile(path.join(base, name), content);
    }
    const carrier = await createCarrier(kind);
    let writes = 0;
    const resources = await transfer(carrier, snapshot, {
      tunnel: {
        runWorkspaceCommand: (command) => {
          expect(Buffer.byteLength(command.input!)).toBeLessThanOrEqual(
            NODE_WORKER_WORKSPACE_STDIN_MAX_BYTES,
          );
          writes += Number(JSON.parse(command.input!).op === "write");
          return carrier.runWorkspaceCommand(command);
        },
      },
    });
    await withResources(resources, async (_resources, remote) => {
      expect(await readBinary(remote)).toEqual(binary);
      for (const [name, content] of files) {
        expect(await readText(remote, name)).toBe(content);
      }
      expect(writes).toBeLessThanOrEqual(3);
    });
  });

  it("rejects a valid-shaped init reply advertising a different allocation", async () => {
    const { snapshot } = await createSource();
    const carrier = trackAllocation(await createNodeCarrier(temps.make("skill-resource-node-")));
    const outside = await fs.realpath(temps.make("skill-resource-wrong-mount-"));
    let writes = 0;
    const request: Partial<TransferOptions> = {
      tunnel: {
        runWorkspaceCommand: async (
          command: Parameters<WorkerWorkspaceTunnelHandle["runWorkspaceCommand"]>[0],
        ) => {
          const operation = JSON.parse(command.input!);
          writes += Number(operation.op === "write");
          const result = await carrier.runWorkspaceCommand(command);
          if (operation.op === "init") {
            return {
              ...result,
              stdout: JSON.stringify({
                id: randomUUID().replaceAll("-", ""),
                identity: result.stdout,
                root: outside,
              }),
            };
          }
          return result;
        },
      },
    };
    await expect(transfer(carrier, snapshot, request)).rejects.toThrow("Invalid skill resource");
    expect(writes).toBe(0);
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it.each(["malformed", "retired"])(
    "reclaims uncertain init on the next turn or generation retirement (%s)",
    async (failure) => {
      const { snapshot } = await createSource();
      const carrier = trackAllocation(await createNodeCarrier(temps.make("skill-resource-node-")));
      let writes = 0;
      let current = true;
      const request: Partial<TransferOptions> = {
        assertCurrent: () => {
          if (!current) {
            throw new Error("placement retired");
          }
        },
        tunnel: {
          runWorkspaceCommand: async (
            command: Parameters<WorkerWorkspaceTunnelHandle["runWorkspaceCommand"]>[0],
          ) => {
            const operation = JSON.parse(command.input!);
            writes += Number(operation.op === "write");
            const result = await carrier.runWorkspaceCommand(command);
            if (operation.op === "init") {
              if (failure === "retired") {
                current = false;
              }
              if (failure === "malformed") {
                return { ...result, stdout: "invalid" };
              }
            }
            return result;
          },
        },
      };
      await expect(transfer(carrier, snapshot, request)).rejects.toThrow();
      expect(writes).toBe(0);
      expect(carrier.allocated).toBeDefined();
      const restarted = new NodeWorkerWorkspaceRuntime({ root: carrier.home });
      const retention = {
        version: 1 as const,
        gatewayNamespace: carrier.binding.gatewayNamespace,
        controllerId: "restarted-gateway",
        sequence: 1,
        retain: [{ ...carrier.binding, manifestRefs: null }],
      };
      await restarted.applyRetainSnapshot(retention, async () => []);
      expect((await fs.stat(carrier.allocated!)).isDirectory()).toBe(true);
      if (failure === "retired") {
        await restarted.applyRetainSnapshot(
          { ...retention, sequence: 2, retain: [] },
          async () => [],
        );
        await expectMissing(carrier.allocated!);
      } else {
        const previousAllocation = carrier.allocated!;
        await withResources(await transfer(carrier, snapshot), async () => {
          await expectMissing(previousAllocation);
          expect((await fs.stat(carrier.workspace)).isDirectory()).toBe(true);
        });
      }
    },
  );

  it("recovers lost cleanup without deleting attachments, project files, or linked markers", async () => {
    const { snapshot, binary } = await createSource();
    const carrier = await createCarrier();
    let disconnected = false;
    const resources = await transfer(carrier, snapshot, {
      tunnel: {
        runWorkspaceCommand: (command) => {
          if (disconnected) {
            throw new Error("connection lost");
          }
          return carrier.runWorkspaceCommand(command);
        },
      },
    });
    const remote = resources!.mounts[0]!.containerPath;
    disconnected = true;
    await expect(resources!.cleanup()).rejects.toThrow("connection lost");
    const candidate = () =>
      path.join(carrier.workspace, WORKER_ATTACHMENT_DIRECTORY_PREFIX + randomUUID());
    const preserved = [
      candidate(),
      path.join(carrier.workspace, "project-inputs"),
      candidate(),
      path.join(carrier.workspace, WORKER_ATTACHMENT_DIRECTORY_PREFIX + "project-inputs"),
    ];
    for (const directory of preserved) {
      await fs.mkdir(directory);
      await fs.writeFile(path.join(directory, "keep.txt"), "keep");
    }
    await fs.writeFile(path.join(preserved[1]!, ".gitignore"), "*\n");
    await fs.writeFile(path.join(preserved[2]!, ".gitignore"), "*\n# project-owned\n");
    await fs.writeFile(path.join(preserved[3]!, ".gitignore"), "*\n");
    const outside = await fs.realpath(temps.make("skill-resource-preserved-"));
    const externalMarker = path.join(outside, ".gitignore");
    await fs.writeFile(externalMarker, "*\n");
    await fs.writeFile(path.join(outside, "keep.txt"), "keep");
    const linkedRoot = candidate();
    await fs.symlink(outside, linkedRoot, process.platform === "win32" ? "junction" : "dir");
    preserved.push(linkedRoot);
    for (const link of process.platform === "win32" ? ["hard"] : ["hard", "symbolic"]) {
      const directory = candidate();
      await fs.mkdir(directory);
      await fs.writeFile(path.join(directory, "keep.txt"), "keep");
      const marker = path.join(directory, ".gitignore");
      if (link === "hard") {
        await fs.link(externalMarker, marker);
      } else {
        await fs.symlink(externalMarker, marker, "file");
      }
      preserved.push(directory);
    }
    await expect(
      transfer(carrier, undefined, {
        assertCurrent: () => {
          throw new Error("placement retired");
        },
      }),
    ).rejects.toThrow("placement retired");
    expect(await readBinary(remote)).toEqual(binary);
    await transfer(carrier);
    await expectMissing(path.dirname(remote));
    for (const directory of preserved) {
      expect(await readText(directory, "keep.txt")).toBe("keep");
    }
    expect((await fs.lstat(linkedRoot)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(externalMarker, "utf8")).toBe("*\n");
  });

  it("preserves a replacement turn's resources when an old SSH command arrives late", async () => {
    const { snapshot, binary } = await createSource();
    const carrier = await createCarrier();
    const dispatched = createDeferred();
    const executeReceiver = createDeferred();
    let current = true;
    let firstCommand = true;
    const oldAttempt = transfer(carrier, undefined, {
      assertCurrent: () => {
        if (!current) {
          throw new Error("placement retired");
        }
      },
      tunnel: {
        runWorkspaceCommand: async (command) => {
          command.assertCurrent?.();
          if (firstCommand) {
            firstCommand = false;
            dispatched.resolve();
            await executeReceiver.promise;
          }
          // SSH already accepted this request; its receiver cannot call back into the Gateway.
          const { assertCurrent: _assertCurrent, ...received } = command;
          return carrier.runWorkspaceCommand(received);
        },
      },
    });
    const oldSettled = oldAttempt.catch(() => {});
    try {
      await dispatched.promise;
      current = false;
      const replacement = await transfer(carrier, snapshot);
      const remote = replacement!.mounts[0]!.containerPath;
      expect(await readBinary(remote)).toEqual(binary);
      executeReceiver.resolve();
      await expect(oldAttempt).rejects.toThrow("placement retired");
      expect(await readBinary(remote)).toEqual(binary);
      await replacement!.cleanup();
    } finally {
      executeReceiver.resolve();
      await oldSettled;
    }
  });

  it("keeps node resources private across a project path collision and partial cleanup", async () => {
    const { snapshot, binary } = await createSource();
    const carrier = trackAllocation(await createNodeCarrier(temps.make("skill-resource-node-")));
    const outside = await fs.realpath(temps.make("skill-resource-project-link-"));
    await fs.writeFile(path.join(outside, "SKILL.md"), "project marker");
    await fs.symlink(
      outside,
      path.join(carrier.workspace, "0"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const git = (argv: string[]) =>
      carrier.runWorkspaceCommand({ argv: ["git", ...argv], transportRetry: "never" });
    expect((await git(["init"])).code).toBe(0);
    await fs.writeFile(path.join(carrier.workspace, "project.txt"), "project");
    expect((await git(["add", "--all"])).code).toBe(0);
    const trackedBefore = await git(["ls-files"]);
    expect(trackedBefore.code).toBe(0);
    const before = await git(["status", "--porcelain", "--untracked-files=all"]);
    expect(before.code).toBe(0);
    const expectProjectUnchanged = async () => {
      const after = await git(["status", "--porcelain", "--untracked-files=all"]);
      const added = await git(["add", "--all"]);
      const tracked = await git(["ls-files"]);
      expect.soft(after).toMatchObject({ code: 0, stdout: before.stdout });
      expect(added.code).toBe(0);
      expect.soft(tracked).toMatchObject({ code: 0, stdout: trackedBefore.stdout });
    };
    let failCleanup = true;
    const requestSizes: number[] = [];
    const resources = await transfer(carrier, snapshot, {
      tunnel: {
        runWorkspaceCommand: async (command) => {
          requestSizes.push(Buffer.byteLength(command.input!));
          let dispatched = command;
          if (JSON.parse(command.input!).op === "cleanup" && failCleanup) {
            failCleanup = false;
            // Fail after deleting one payload, as when another resource is still open.
            const partialCleanup = `{
                const fs = require('node:fs'), remove = fs.rmSync;
                fs.rmSync = (entry, options) => {
                  if (entry === '0') {
                    remove('0/data.bin');
                    throw Error('resource still open');
                  }
                  return remove(entry, options);
                };
              }`;
            dispatched = {
              ...command,
              argv: [
                ...command.argv.slice(0, 2),
                partialCleanup + command.argv[2],
                ...command.argv.slice(3),
              ],
            };
          }
          return carrier.runWorkspaceCommand(dispatched);
        },
      },
    });
    const remote = resources!.mounts[0]!.containerPath;
    expect(remote.startsWith(carrier.workspace)).toBe(true);
    expect(await readBinary(remote)).toEqual(binary);
    expect(await readText(outside, "SKILL.md")).toBe("project marker");
    const manifest = await captureWorkspaceManifest({
      root: carrier.workspace,
      baseCommit: null,
    });
    expect(manifest.manifest.entries.map((entry) => entry.path)).toEqual(["project.txt"]);
    await expectProjectUnchanged();
    const largestRequest = Math.max(...requestSizes);
    expect(largestRequest).toBeLessThanOrEqual(NODE_WORKER_WORKSPACE_STDIN_MAX_BYTES);
    expect(NODE_WORKER_WORKSPACE_STDIN_MAX_BYTES - largestRequest).toBeLessThan(4);
    await expect(resources!.cleanup()).rejects.toThrow("Skill resource cleanup failed");
    await expectMissing(path.join(remote, "data.bin"));
    expect(await readText(remote, "scripts/check.sh")).toBe("#!/bin/sh\nprintf ready\n");
    await expectProjectUnchanged();
    await resources!.cleanup();
    await expectMissing(carrier.allocated!);
  });

  it("rejects remote directory identities that collide when rounded to numbers", async () => {
    const { snapshot } = await createSource();
    const carrier = await createCarrier();
    await expect(
      transfer(carrier, snapshot, {
        tunnel: {
          runWorkspaceCommand: async (command) => {
            const initializing = JSON.parse(command.input!).op === "init";
            // Model adjacent Windows file indexes while retaining the real filesystem flow.
            const identityShim = `{
                const fs = require('node:fs');
                for (const method of ['lstatSync', 'statSync']) {
                  const original = fs[method];
                  fs[method] = (...args) => {
                    const stat = original(...args);
                    const ino = 9007199254740992n + ${initializing ? 0 : 1}n;
                    stat.ino = typeof stat.ino === 'bigint' ? ino : Number(ino);
                    return stat;
                  };
                }
              }`;
            return carrier.runWorkspaceCommand({
              ...command,
              argv: [
                ...command.argv.slice(0, 2),
                identityShim + command.argv[2],
                ...command.argv.slice(3),
              ],
            });
          },
        },
      }),
    ).rejects.toThrow("Skill resource transfer failed");
    expect(carrier.allocated).toBeDefined();
    await expect(fs.readdir(carrier.allocated!)).resolves.toEqual([".gitignore"]);
  });

  it.each(
    ["node"].flatMap((carrier) =>
      ["cancelled", "retired"].map((outcome) => ({ carrier, outcome })),
    ),
  )(
    "preserves private resources and cleans up only its current owner ($carrier, $outcome)",
    async ({ carrier, outcome }) => {
      const { workspace, filePath, binary, snapshot } = await createSource();
      const controller = new AbortController();
      const transport = await createCarrier(carrier);
      let current = true;
      const resources = await transfer(transport, snapshot, {
        signal: controller.signal,
        assertCurrent: () => {
          if (!current) {
            throw new Error("placement retired");
          }
        },
      });
      expect(resources).toBeDefined();
      const remote = resources!.mounts[0]!.containerPath;
      try {
        expect(remote.startsWith(workspace)).toBe(false);
        expect(await fs.readFile(path.join(remote, "SKILL.md"))).toEqual(
          await fs.readFile(filePath),
        );
        expect(resources!.snapshot.resolvedSkills![0]!.name).toBe("source");
        expect(await readBinary(remote)).toEqual(binary);
        const executableMode = (await fs.stat(path.join(remote, "scripts/check.sh"))).mode;
        const dataMode = (await fs.stat(path.join(remote, "data.bin"))).mode;
        if (process.platform === "win32") {
          expect(executableMode & 0o222).toBe(0);
          expect(dataMode & 0o222).toBe(0);
        } else {
          expect(executableMode & 0o777).toBe(0o500);
          expect(dataMode & 0o777).toBe(0o400);
        }
        const selected = resources!.snapshot.resolvedSkills![0]!;
        const instructions = await fs.readFile(filePath, "utf8");
        expect(selected).toMatchObject({
          filePath: `${remote}/SKILL.md`,
          baseDir: remote,
        });
        expect(selected.sourceInfo).toEqual(snapshot.resolvedSkills![0]!.sourceInfo);
        expect(snapshot.resolvedSkills![0]!.filePath).toBe(filePath);
        for (const prompt of [
          resources!.snapshot.prompt,
          formatSkillsCompactForPrompt([selected], { descriptionMaxChars: 0 }),
        ]) {
          expect(prompt).toContain(`<location>${remote}/SKILL.md</location>`);
          expect(prompt).not.toContain(filePath);
        }
        await fs.writeFile(filePath, "Instructions changed after transfer");
        const [codeModeSkill] = resolveCodeModeSkills({
          skillsPrompt: resources!.snapshot.prompt,
          candidates: [selected],
          reader: async () => {
            throw new Error("Paired nodes have no Gateway filesystem bridge");
          },
        });
        expect(await readCodeModeSkill(codeModeSkill!)).toBe(instructions);
        expect(await fs.readFile(selected.filePath, "utf8")).toBe(instructions);
        if (outcome === "cancelled") {
          controller.abort();
        } else if (outcome === "retired") {
          current = false;
        }
        if (outcome === "retired") {
          await expect(resources!.cleanup()).rejects.toThrow("placement retired");
          expect(await readBinary(remote)).toEqual(binary);
        } else {
          await expect(resources!.cleanup()).resolves.toBeUndefined();
          await expectMissing(remote);
        }
      } finally {
        await remove(path.dirname(remote));
      }
    },
  );

  it.each([
    { name: "empty batch", patch: { files: [] } },
    { name: "invalid batch member", patch: { files: [null] } },
    { name: "forged directory", patch: { directory: "../outside" } },
    {
      name: "unallocated directory",
      patch: { directory: WORKER_ATTACHMENT_DIRECTORY_PREFIX + randomUUID() },
    },
    { name: "wrong inode", patch: { identity: "0:0" } },
    { name: "absolute root input", patch: { root: "/tmp" } },
    { name: "digest mismatch", target: "file", patch: { hash: "0".repeat(64) } },
    { name: "Windows alternate data stream", target: "file", patch: { name: "0/data.bin:stream" } },
    { name: "Windows trailing-space parent", target: "file", patch: { name: "0/.. /marker" } },
    { name: "Windows reserved device", target: "file", patch: { name: "0/NUL" } },
    { name: "Windows console input", target: "file", patch: { name: "0/CONIN$" } },
    { name: "Windows superscript COM device", target: "file", patch: { name: "0/COM¹.txt" } },
  ])("rejects $name and cleans only the allocated resources", async ({ patch, target }) => {
    await expectRejectedResourceRequest("node", (input) => {
      const request = JSON.parse(input);
      if (target === "file") {
        request.files[0] = { ...request.files[0], ...patch };
      } else {
        Object.assign(request, patch);
      }
      return JSON.stringify(request);
    });
  });

  it("rejects resource-relative traversal without writing outside its owned directory", async () => {
    const outside = await fs.realpath(temps.make("skill-resource-escape-"));
    await expectRejectedResourceRequest("node", (input) => {
      const request = JSON.parse(input);
      request.files[0].name = `../${path.basename(outside)}/marker`;
      return JSON.stringify(request);
    });
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it.each(["ssh", "node"])(
    "rejects an oversized typed resource request over %s",
    async (carrier) => {
      await expectRejectedResourceRequest(
        carrier,
        (input) =>
          input + " ".repeat(NODE_WORKER_WORKSPACE_STDIN_MAX_BYTES + 1 - Buffer.byteLength(input)),
        carrier === "node"
          ? "workspace command input exceeds its bound"
          : "Skill resource transfer failed",
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "omits a stale discovered skill from the transferred snapshot and prompt",
    async () => {
      const snapshot = await createStaleSource();
      const carrier = await createCarrier();
      await withResources(await transfer(carrier, snapshot), async (resources) => {
        expect(resources.mounts).toHaveLength(1);
        expect(resources.snapshot.skills.map((skill) => skill.name)).toEqual(["source"]);
        expect(resources.snapshot.resolvedSkills?.map((skill) => skill.name)).toEqual(["source"]);
        expect(resources.snapshot.prompt).not.toContain("stale");
        const restoreEnv = applySkillEnvOverridesFromSnapshot({
          snapshot: resources.snapshot,
          config: {
            skills: {
              entries: { stale: { apiKey: "must-not-apply" } }, // pragma: allowlist secret
            },
          },
        });
        try {
          expect(process.env.STALE_SKILL_API_KEY).toBeUndefined();
        } finally {
          restoreEnv();
        }
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "retains a skill identity when a same-named node skill remains active",
    async () => {
      const snapshot = await createStaleSource(true);
      const carrier = await createCarrier();
      await withResources(await transfer(carrier, snapshot), async (resources) => {
        expect(resources.snapshot.skills.map((skill) => skill.name)).toEqual(["source", "stale"]);
        expect(resources.snapshot.resolvedSkills?.map((skill) => skill.name)).toEqual([
          "source",
          "stale",
        ]);
      });
    },
  );

  it.each(
    ["ssh"].flatMap((carrier) =>
      ["init", "write"].flatMap((phase) =>
        ["abort", "authority"].map((revocation) => ({ carrier, phase, revocation })),
      ),
    ),
  )(
    "cleans the accepted remote directory when $revocation arrives with $phase ($carrier)",
    async ({ carrier, phase, revocation }) => {
      const { snapshot } = await createSource();
      const transport = await createCarrier(carrier);
      const controller = new AbortController();
      let runCurrent = true;
      await expect(
        transfer(transport, snapshot, {
          signal: controller.signal,
          assertRunCurrent: () => {
            if (!runCurrent) {
              throw new DOMException("run authority closed", "AbortError");
            }
          },
          tunnel: {
            runWorkspaceCommand: async (command) => {
              const result = await transport.runWorkspaceCommand(command);
              if (JSON.parse(command.input!).op === phase) {
                if (revocation === "abort") {
                  controller.abort();
                } else {
                  runCurrent = false;
                }
              }
              return result;
            },
          },
        }),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(transport.allocated).toBeDefined();
      await expectMissing(transport.allocated!);
    },
  );
});
