import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
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
  NODE_WORKER_WORKSPACE_STDIN_MAX_BYTES as INPUT_LIMIT,
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

function trackAllocation<T>(carrier: T): T & { allocated: string | undefined; writes: number } {
  return { ...carrier, allocated: undefined, writes: 0 };
}

async function createCarrier(kind = "ssh") {
  return trackAllocation(
    kind === "node"
      ? await createNodeCarrier(temps.make("skill-resource-node-"))
      : { ...tunnel, workspace: await fs.realpath(temps.make("skill-resource-ssh-")) },
  );
}

type TransferOptions = Parameters<typeof transferSkillResources>[0];
type Command = Parameters<WorkerWorkspaceTunnelHandle["runWorkspaceCommand"]>[0];
type CommandResult = Awaited<ReturnType<WorkerWorkspaceTunnelHandle["runWorkspaceCommand"]>>;
type Interception = {
  before?: (command: Command, op: string) => Command | Promise<Command>;
  after?: (result: CommandResult, op: string) => CommandResult | Promise<CommandResult>;
};
type Carrier = Awaited<ReturnType<typeof createCarrier>>;
function transfer(
  carrier: Carrier,
  snapshot?: TransferOptions["snapshot"],
  options: Partial<TransferOptions> & Interception = {},
) {
  const { before, after, ...params } = options;
  return transferSkillResources({
    snapshot,
    tunnel: {
      runWorkspaceCommand: async (command) => {
        const { op, directory } = JSON.parse(command.input!);
        carrier.writes += Number(op === "write");
        const result = await carrier.runWorkspaceCommand(
          before ? await before(command, op) : command,
        );
        if (op === "init") {
          carrier.allocated = path.join(carrier.workspace, directory);
        }
        return after ? after(result, op) : result;
      },
    },
    remoteWorkspaceDir: carrier.workspace,
    assertCurrent: () => {},
    ...params,
  });
}

const expectMissing = (file: string) =>
  expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
const readText = (directory: string, file: string) =>
  fs.readFile(path.join(directory, file), "utf8");
const readBinary = (directory: string) => fs.readFile(path.join(directory, "data.bin"));
const prependScript = (command: Command, script: string): Command => ({
  ...command,
  argv: [...command.argv.slice(0, 2), script + command.argv[2], ...command.argv.slice(3)],
});
const directoryLink = process.platform === "win32" ? "junction" : "dir";
function placementClaim(error = new Error("placement retired")) {
  let current = true;
  return {
    retire: () => {
      current = false;
    },
    assertCurrent: () => {
      if (!current) {
        throw error;
      }
    },
  };
}

async function fixture(kind = "ssh", binarySize = 150000) {
  return { ...(await createSource(binarySize)), carrier: await createCarrier(kind) };
}

async function writeFile(root: string, name: string, bytes: string | Uint8Array, mode?: number) {
  const target = path.join(root, name);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, bytes, { mode });
}

async function withResources(
  resources: Awaited<ReturnType<typeof transferSkillResources>>,
  check: (
    resources: NonNullable<Awaited<ReturnType<typeof transferSkillResources>>>,
    remote: string,
  ) => Promise<void>,
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
  const filePath = path.join(baseDir, "SKILL.md");
  await writeFile(baseDir, "SKILL.md", "---\ndescription: Transfer\n---\n# Resources\n");
  const binary = Buffer.alloc(binarySize, 129);
  await writeFile(baseDir, "data.bin", binary);
  await writeFile(baseDir, "scripts/check.sh", "#!/bin/sh\nprintf ready\n", 0o700);
  const entries = loadWorkspaceSkills(workspace, { workspaceOnly: true });
  const snapshot = await buildSkillSnapshot(workspace, { entries });
  return { workspace, filePath, binary, snapshot };
}

async function createStaleSource(sameNamedNode = false) {
  const source = await createSource();
  const staleBaseDir = path.join(source.workspace, "skills", "stale");
  await writeFile(staleBaseDir, "SKILL.md", "---\ndescription: Stale resource\n---\n# Stale\n");
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
      before: (command, op) => {
        if (op !== "write" || injected) {
          return command;
        }
        injected = true;
        return { ...command, input: mutate(command.input!) };
      },
    }),
  ).rejects.toThrow(message);
  expect(injected).toBe(true);
  await expectMissing(transport.allocated!);
}

it("transfers host bytes rather than stale Gateway bytes", async () => {
  const source = await createSource(16);
  const hostRoot = temps.make("skill-resource-host-");
  await fs.cp(source.workspace, hostRoot, { recursive: true });
  const script = "#!/bin/sh\nprintf host-script\n";
  await fs.writeFile(path.join(hostRoot, "skills/source/scripts/check.sh"), script);
  const hostPath = (file: string) => path.join(hostRoot, path.relative(source.workspace, file));
  const unexpected = async () => {
    throw new Error("Unexpected document bridge access");
  };
  const release = registerAgentWorkspaceAccess(source.workspace, {
    bridge: { readFile: unexpected, writeFile: unexpected, stat: unexpected },
    loadSkills: async (request) =>
      readWorkspaceSkillSources({
        ...request,
        sourcePlan: resolveWorkspaceSkillSourcePlan(hostRoot, { workspaceOnly: true }),
      }),
    skillResources: {
      readInstructions: (filePath, options) =>
        fs.readFile(hostPath(filePath), { ...options, encoding: "utf8" }),
      resolveExplicitSkill: resolveExplicitSkillResource,
      readSkillFiles: (skill, options) =>
        readSkillResourceFiles({ ...skill, baseDir: hostPath(skill.baseDir) }, options),
    },
  });
  const carrier = await createCarrier("node");
  try {
    await withResources(
      await transfer(carrier, source.snapshot, { workspaceDir: source.workspace }),
      async (_resources, remote) => expect(await readText(remote, "scripts/check.sh")).toBe(script),
    );
  } finally {
    release();
  }
});

it("batches small SSH resources within the input budget", async () => {
  const { snapshot, filePath, binary, carrier } = await fixture();
  const base = path.dirname(filePath);
  const files = new Map<string, string>([["empty.txt", ""]]);
  for (let index = 0; index < 20; index += 1) {
    files.set(`nested/${index}/résumé.txt`, `resource ${index}\n`);
  }
  for (const [name, content] of files) {
    await writeFile(base, name, content);
  }
  const resources = await transfer(carrier, snapshot, {
    before: (command) => {
      expect(Buffer.byteLength(command.input!)).toBeLessThanOrEqual(INPUT_LIMIT);
      return command;
    },
  });
  await withResources(resources, async (_resources, remote) => {
    expect(await readBinary(remote)).toEqual(binary);
    for (const [name, content] of files) {
      expect(await readText(remote, name)).toBe(content);
    }
    expect(carrier.writes).toBeLessThanOrEqual(3);
  });
});

it("rejects a valid-shaped init reply advertising a different allocation", async () => {
  const { snapshot } = await createSource();
  const carrier = trackAllocation(await createNodeCarrier(temps.make("skill-resource-node-")));
  const outside = await fs.realpath(temps.make("skill-resource-wrong-mount-"));
  const id = randomUUID().replaceAll("-", "");
  const request: Interception = {
    after: (result, op) =>
      op === "init"
        ? {
            ...result,
            stdout: JSON.stringify({ id, identity: result.stdout, root: outside }),
          }
        : result,
  };
  await expect(transfer(carrier, snapshot, request)).rejects.toThrow("Invalid skill resource");
  expect(carrier.writes).toBe(0);
  expect(await fs.readdir(outside)).toEqual([]);
});

it.each(["malformed", "retired"])(
  "reclaims uncertain init on the next turn or generation retirement (%s)",
  async (failure) => {
    const { snapshot } = await createSource();
    const carrier = trackAllocation(await createNodeCarrier(temps.make("skill-resource-node-")));
    const claim = placementClaim();
    const request: Partial<TransferOptions> & Interception = {
      assertCurrent: claim.assertCurrent,
      after: (result, op) => {
        if (op === "init" && failure === "retired") {
          claim.retire();
        }
        return op === "init" && failure === "malformed" ? { ...result, stdout: "invalid" } : result;
      },
    };
    await expect(transfer(carrier, snapshot, request)).rejects.toThrow();
    expect(carrier.writes).toBe(0);
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
  const { snapshot, binary, carrier } = await fixture();
  let disconnected = false;
  const resources = await transfer(carrier, snapshot, {
    before: (command) => {
      if (disconnected) {
        throw new Error("connection lost");
      }
      return command;
    },
  });
  const remote = resources!.mounts[0]!.containerPath;
  disconnected = true;
  await expect(resources!.cleanup()).rejects.toThrow("connection lost");
  const candidate = (id: string = randomUUID()) =>
    path.join(carrier.workspace, WORKER_ATTACHMENT_DIRECTORY_PREFIX + id);
  const preserved = [
    candidate(),
    path.join(carrier.workspace, "project-inputs"),
    candidate(),
    candidate("project-inputs"),
  ];
  for (const directory of preserved) {
    await writeFile(directory, "keep.txt", "keep");
  }
  await fs.writeFile(path.join(preserved[1]!, ".gitignore"), "*\n");
  await fs.writeFile(path.join(preserved[2]!, ".gitignore"), "*\n# project-owned\n");
  await fs.writeFile(path.join(preserved[3]!, ".gitignore"), "*\n");
  const outside = await fs.realpath(temps.make("skill-resource-preserved-"));
  const externalMarker = path.join(outside, ".gitignore");
  await fs.writeFile(externalMarker, "*\n");
  await fs.writeFile(path.join(outside, "keep.txt"), "keep");
  const linkedRoot = candidate();
  await fs.symlink(outside, linkedRoot, directoryLink);
  preserved.push(linkedRoot);
  for (const link of process.platform === "win32" ? ["hard"] : ["hard", "symbolic"]) {
    const directory = candidate();
    await writeFile(directory, "keep.txt", "keep");
    const marker = path.join(directory, ".gitignore");
    await (link === "hard"
      ? fs.link(externalMarker, marker)
      : fs.symlink(externalMarker, marker, "file"));
    preserved.push(directory);
  }
  const retired = placementClaim();
  retired.retire();
  await expect(
    transfer(carrier, undefined, { assertCurrent: retired.assertCurrent }),
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
  const { snapshot, binary, carrier } = await fixture();
  const dispatched = createDeferred();
  const executeReceiver = createDeferred();
  const claim = placementClaim();
  let firstCommand = true;
  const oldAttempt = transfer(carrier, undefined, {
    assertCurrent: claim.assertCurrent,
    before: async (command) => {
      command.assertCurrent?.();
      if (firstCommand) {
        firstCommand = false;
        dispatched.resolve();
        await executeReceiver.promise;
      }
      // SSH already accepted this request; its receiver cannot call back into the Gateway.
      const { assertCurrent: _assertCurrent, ...received } = command;
      return received;
    },
  });
  const oldSettled = oldAttempt.catch(() => {});
  try {
    await dispatched.promise;
    claim.retire();
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
  await fs.symlink(outside, path.join(carrier.workspace, "0"), directoryLink);
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
    before: (command, op) => {
      requestSizes.push(Buffer.byteLength(command.input!));
      let dispatched = command;
      if (op === "cleanup" && failCleanup) {
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
        dispatched = prependScript(command, partialCleanup);
      }
      return dispatched;
    },
  });
  const remote = resources!.mounts[0]!.containerPath;
  expect(remote.startsWith(carrier.workspace)).toBe(true);
  expect(await readBinary(remote)).toEqual(binary);
  expect(await readText(outside, "SKILL.md")).toBe("project marker");
  const manifest = await captureWorkspaceManifest({ root: carrier.workspace, baseCommit: null });
  expect(manifest.manifest.entries.map((entry) => entry.path)).toEqual(["project.txt"]);
  await expectProjectUnchanged();
  const largestRequest = Math.max(...requestSizes);
  expect(largestRequest).toBeLessThanOrEqual(INPUT_LIMIT);
  expect(INPUT_LIMIT - largestRequest).toBeLessThan(4);
  await expect(resources!.cleanup()).rejects.toThrow("Skill resource cleanup failed");
  await expectMissing(path.join(remote, "data.bin"));
  expect(await readText(remote, "scripts/check.sh")).toBe("#!/bin/sh\nprintf ready\n");
  await expectProjectUnchanged();
  await resources!.cleanup();
  await expectMissing(carrier.allocated!);
});

it("rejects remote directory identities that collide when rounded to numbers", async () => {
  const { snapshot, carrier } = await fixture();
  await expect(
    transfer(carrier, snapshot, {
      before: (command, op) => {
        const initializing = op === "init";
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
        return prependScript(command, identityShim);
      },
    }),
  ).rejects.toThrow("Skill resource transfer failed");
  expect(carrier.allocated).toBeDefined();
  await expect(fs.readdir(carrier.allocated!)).resolves.toEqual([".gitignore"]);
});

it.each(["cancelled", "retired"])(
  "keeps private node resources until owner cleanup (%s)",
  async (outcome) => {
    const { workspace, filePath, binary, snapshot, carrier: transport } = await fixture("node");
    const controller = new AbortController();
    const claim = placementClaim();
    const resources = await transfer(transport, snapshot, {
      signal: controller.signal,
      assertCurrent: claim.assertCurrent,
    });
    expect(resources).toBeDefined();
    const remote = resources!.mounts[0]!.containerPath;
    expect(remote.startsWith(workspace)).toBe(false);
    expect(await fs.readFile(path.join(remote, "SKILL.md"))).toEqual(await fs.readFile(filePath));
    expect(resources!.snapshot.resolvedSkills![0]!.name).toBe("source");
    expect(await readBinary(remote)).toEqual(binary);
    const windows = process.platform === "win32";
    const modes = [
      ["scripts/check.sh", 0o500],
      ["data.bin", 0o400],
    ] as const;
    for (const [file, mode] of modes) {
      expect((await fs.stat(path.join(remote, file))).mode & (windows ? 0o222 : 0o777)).toBe(
        windows ? 0 : mode,
      );
    }
    const selected = resources!.snapshot.resolvedSkills![0]!;
    const instructions = await fs.readFile(filePath, "utf8");
    expect(selected).toMatchObject({ filePath: `${remote}/SKILL.md`, baseDir: remote });
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
      claim.retire();
    }
    if (outcome === "retired") {
      await expect(resources!.cleanup()).rejects.toThrow("placement retired");
      expect(await readBinary(remote)).toEqual(binary);
    } else {
      await expect(resources!.cleanup()).resolves.toBeUndefined();
      await expectMissing(remote);
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

it.each(["ssh", "node"])("rejects an oversized typed resource request over %s", async (carrier) => {
  await expectRejectedResourceRequest(
    carrier,
    (input) => input + " ".repeat(INPUT_LIMIT + 1 - Buffer.byteLength(input)),
    carrier === "node"
      ? "workspace command input exceeds its bound"
      : "Skill resource transfer failed",
  );
});

it.runIf(process.platform !== "win32").each([false, true])(
  "filters stale local skills, retaining same-named node skills: %s",
  async (sameNamedNode) => {
    const snapshot = await createStaleSource(sameNamedNode);
    const carrier = await createCarrier();
    await withResources(await transfer(carrier, snapshot), async (resources) => {
      const names = sameNamedNode ? ["source", "stale"] : ["source"];
      expect(resources.snapshot.skills.map((skill) => skill.name)).toEqual(names);
      expect(resources.snapshot.resolvedSkills?.map((skill) => skill.name)).toEqual(names);
      if (sameNamedNode) {
        return;
      }
      expect(resources.mounts).toHaveLength(1);
      expect(resources.snapshot.prompt).not.toContain("stale");
      const entries = { stale: { apiKey: "must-not-apply" } }; // pragma: allowlist secret
      const restoreEnv = applySkillEnvOverridesFromSnapshot({
        snapshot: resources.snapshot,
        config: { skills: { entries } },
      });
      try {
        expect(process.env.STALE_SKILL_API_KEY).toBeUndefined();
      } finally {
        restoreEnv();
      }
    });
  },
);

it.each(
  ["init", "write"].flatMap((phase) =>
    ["abort", "authority"].map((revocation) => ({ phase, revocation })),
  ),
)("cleans accepted SSH resources after $revocation with $phase", async ({ phase, revocation }) => {
  const { snapshot, carrier: transport } = await fixture();
  const controller = new AbortController();
  const claim = placementClaim(new DOMException("run authority closed", "AbortError"));
  await expect(
    transfer(transport, snapshot, {
      signal: controller.signal,
      assertRunCurrent: claim.assertCurrent,
      after: (result, op) => {
        if (op === phase) {
          if (revocation === "abort") {
            controller.abort();
          } else {
            claim.retire();
          }
        }
        return result;
      },
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(transport.allocated).toBeDefined();
  await expectMissing(transport.allocated!);
});
