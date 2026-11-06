import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  chmod,
  copyFile,
  mkdir,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { managedSetupPodmanEnv } from "./managed-setup-podman.mjs";

type Receipt = {
  command: string;
  leaseId?: string;
  checkpointId?: string;
  exitCode?: number;
  scriptSha256?: string;
};
type Frame = {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  data?: string;
  missing?: boolean;
};
type Request = {
  argv: string[];
  env: Record<string, string>;
  script?: string;
  copy?: { leaseId: string; path: string; data: string };
};
type Container = { Names: string[]; State: string; Labels: Record<string, string> };
type GuestRequest =
  | { operation: "ping" }
  | { operation: "read"; path: string }
  | { operation: "write"; path: string; data: string }
  | { operation: "run"; env: Record<string, string>; script: string };

const OWNER_LABEL = "io.openclaw.managed-setup.owner";
const CREATED_LABEL = "io.openclaw.managed-setup.created-at";
const LEASE_SECONDS = 7_200;
const LEASE_LABEL = "io.openclaw.managed-setup.lease";
const SLUG_LABEL = "io.openclaw.managed-setup.slug";
const SOURCE_LABEL = "io.openclaw.managed-setup.source";
const GUEST_PATH = "/managed-setup-guest.mjs";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/** Real, task-owned container storage behind the existing Crabbox binary contract. */
export async function startManagedSetupBackend(options: {
  root: string;
  image: string;
  gitWrapperPath?: string;
  gatewayCaPath?: string;
  gitHttps?: { repositoryPath: string; port: number; keyPath: string; certPath: string };
  /** Delay external read-only metadata, never a dispatched setup command. */
  beforeInspect?: (leaseId: string) => Promise<void>;
}) {
  const root = resolve(options.root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const gitHttpsPath = options.gitHttps ? join(root, "git-https.json") : undefined;
  if (options.gitHttps && gitHttpsPath) {
    await writeFile(
      gitHttpsPath,
      JSON.stringify({
        repositoryPath: options.gitHttps.repositoryPath,
        port: options.gitHttps.port,
        key: await readFile(options.gitHttps.keyPath, "utf8"),
        cert: await readFile(options.gitHttps.certPath, "utf8"),
      }),
      { mode: 0o600 },
    );
  }
  const owner = "openclaw-setup-" + randomUUID();
  const binaryPath = join(root, "crabbox");
  const socketPath = join(root, "backend.sock");
  const receipts: Receipt[] = [];
  // The host process needs Podman's runtime, not provider/proxy credentials.
  const hostEnv = managedSetupPodmanEnv({});
  for (const name of ["PATH", "TMPDIR"]) {
    if (process.env[name] !== undefined) {
      hostEnv[name] = process.env[name];
    }
  }
  const podman = async (args: string[], allowFailure = false, timeout = 120_000) => {
    const child = spawn("podman", args, { env: hostEnv, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (data: string) => (stdout += data));
    child.stderr.setEncoding("utf8").on("data", (data: string) => (stderr += data));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    try {
      const exitCode = await new Promise<number>((resolveExit, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolveExit(code ?? 137));
      });
      if (exitCode !== 0 && !allowFailure) {
        throw new Error("podman " + args[0] + " failed (" + exitCode + "): " + stderr.trim());
      }
      return { stdout, stderr, exitCode };
    } finally {
      clearTimeout(timer);
    }
  };
  if (
    (await podman(["info", "--format", "{{.Host.Security.Rootless}}"])).stdout.trim() !== "true"
  ) {
    throw new Error("managed setup proof requires rootless Podman");
  }
  await podman(["image", "exists", options.image]);
  await writeFile(
    join(root, "backend-owner.json"),
    JSON.stringify({ owner, root, image: options.image }) + "\n",
    { mode: 0o600 },
  );
  await copyFile(
    new URL("./managed-setup-cli.mjs", import.meta.url),
    join(root, "managed-setup-cli.mjs"),
  );
  await writeFile(
    binaryPath,
    "#!/usr/bin/env node\nimport { runManagedSetupCli } from './managed-setup-cli.mjs';\nawait runManagedSetupCli(" +
      JSON.stringify(socketPath) +
      ");\n",
    { mode: 0o700 },
  );
  await chmod(binaryPath, 0o700);
  const nameFor = (leaseId: string) => owner + "-" + hash(leaseId).slice(0, 20);
  const imageFor = (checkpointId: string) => "localhost/" + owner + ":" + checkpointId;
  const containers = async (): Promise<Container[]> =>
    JSON.parse(
      (
        await podman([
          "ps",
          "-a",
          "--filter",
          "label=" + OWNER_LABEL + "=" + owner,
          "--format",
          "json",
        ])
      ).stdout,
    );
  const checkpointTags = async () =>
    (
      await podman([
        "images",
        "--filter",
        "label=" + OWNER_LABEL + "=" + owner,
        "--format",
        "{{.Repository}}:{{.Tag}}",
      ])
    ).stdout
      .trim()
      .split("\n")
      .filter((tag) => tag.startsWith("localhost/" + owner + ":chk_"));
  const findContainer = async (leaseId: string) =>
    (await containers()).find(
      (container) =>
        container.Names.includes(nameFor(leaseId)) &&
        container.Labels[LEASE_LABEL] === leaseId &&
        container.Labels[OWNER_LABEL] === owner,
    );
  const requireContainer = async (leaseId: string) => {
    const container = await findContainer(leaseId);
    if (!container || container.State !== "running") {
      throw new Error("unknown lease " + leaseId);
    }
    return container;
  };
  const hasCheckpoint = async (checkpointId: string) => {
    if (!/^chk_[A-Za-z0-9_-]{1,128}$/.test(checkpointId)) {
      throw new Error("invalid checkpoint id");
    }
    if (!(await checkpointTags()).includes(imageFor(checkpointId))) {
      return false;
    }
    const result = await podman(["image", "exists", imageFor(checkpointId)], true);
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      throw new Error("checkpoint availability could not be established");
    }
    return result.exitCode === 0;
  };
  const guest = async (
    leaseId: string,
    request: GuestRequest,
    onFrame: (frame: Frame) => void,
    signal?: AbortSignal,
  ) => {
    await requireContainer(leaseId);
    signal?.throwIfAborted();
    const child = spawn("podman", ["exec", "-i", nameFor(leaseId), "node", GUEST_PATH, "client"], {
      env: hostEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let exitCode: number | undefined;
    let transportError = "";
    child.stderr.setEncoding("utf8").on("data", (data: string) => (transportError += data));
    child.stdin.on("error", () => {});
    createInterface({ input: child.stdout }).on("line", (line) => {
      const frame: Frame = JSON.parse(line);
      if (frame.exitCode !== undefined) {
        exitCode = frame.exitCode;
      }
      onFrame(frame);
    });
    const cancel = () => child.stdin.write(JSON.stringify({ cancel: true }) + "\n");
    signal?.addEventListener("abort", cancel, { once: true });
    child.stdin.write(JSON.stringify(request) + "\n");
    try {
      const transportCode = await new Promise<number>((resolveExit, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolveExit(code ?? 137));
      });
      if (exitCode === undefined || transportCode !== 0) {
        throw new Error("guest transport failed: " + transportError.trim());
      }
      return exitCode;
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  };
  // Serialize only resource mutations. Runs remain concurrent, including heartbeat.
  let mutationTail = Promise.resolve();
  const mutate = async <T>(operation: () => Promise<T>) => {
    const previous = mutationTail;
    let release!: () => void;
    mutationTail = new Promise<void>((resolveRelease) => {
      release = resolveRelease;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };
  const createLease = async (leaseId: string, slug: string, image: string) => {
    const existing = await findContainer(leaseId);
    if (
      existing &&
      (existing.Labels[SOURCE_LABEL] !== image || existing.Labels[SLUG_LABEL] !== slug)
    ) {
      throw new Error("lease_id_conflict:" + leaseId);
    }
    if (!existing) {
      await podman([
        "create",
        "--name",
        nameFor(leaseId),
        "--timeout",
        String(LEASE_SECONDS),
        "--label",
        CREATED_LABEL + "=" + new Date().toISOString(),
        "--label",
        OWNER_LABEL + "=" + owner,
        "--label",
        LEASE_LABEL + "=" + leaseId,
        "--label",
        SLUG_LABEL + "=" + slug,
        "--label",
        SOURCE_LABEL + "=" + image,
        "--network",
        "slirp4netns:allow_host_loopback=true",
        ...(gitHttpsPath ? ["--add-host", "github.com:127.0.0.1"] : []),
        "--user",
        "0:0",
        "--unsetenv-all",
        "--env",
        "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "--env",
        "HOME=/home/worker",
        ...(options.gatewayCaPath
          ? ["--env", "NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/setup-gateway.crt"]
          : []),
        "--workdir",
        "/",
        "--entrypoint",
        "node",
        image,
        GUEST_PATH,
        "server",
      ]);
      await podman([
        "cp",
        fileURLToPath(new URL("./managed-setup-guest.mjs", import.meta.url)),
        nameFor(leaseId) + ":" + GUEST_PATH,
      ]);
      if (gitHttpsPath) {
        await podman(["cp", gitHttpsPath, nameFor(leaseId) + ":/managed-setup-git-https.json"]);
      }
      if (options.gitWrapperPath) {
        await podman(["cp", options.gitWrapperPath, nameFor(leaseId) + ":/usr/local/bin/git"]);
      }
    }
    if (!existing || existing.State !== "running") {
      if (options.gatewayCaPath) {
        await podman([
          "cp",
          options.gatewayCaPath,
          nameFor(leaseId) + ":/usr/local/share/ca-certificates/setup-gateway.crt",
        ]);
      }
      await podman(["start", nameFor(leaseId)]);
    }
    let failure: unknown;
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        await guest(leaseId, { operation: "ping" }, () => {});
        return;
      } catch (error) {
        failure = error;
        await delay(100);
      }
    }
    throw failure;
  };
  const stopLease = async (leaseId: string) => {
    // ps labels are the authority check immediately before removal; never inspect/prune.
    if (await findContainer(leaseId)) {
      await podman(["rm", "--force", nameFor(leaseId)]);
    }
    const exists = await podman(["container", "exists", nameFor(leaseId)], true);
    if (exists.exitCode !== 1) {
      throw new Error("lease removal not established: " + leaseId);
    }
  };
  const deleteCheckpoint = async (checkpointId: string) => {
    if (!(await hasCheckpoint(checkpointId))) {
      return false;
    }
    await podman(["rmi", imageFor(checkpointId)]);
    if (await hasCheckpoint(checkpointId)) {
      throw new Error("checkpoint removal not established");
    }
    return true;
  };
  const record = async (receipt: Receipt) => {
    receipts.push(receipt);
    // Evidence only: live inventory always comes from task-labelled Podman resources.
    await appendFile(join(root, "backend-receipts.jsonl"), JSON.stringify(receipt) + "\n", {
      mode: 0o600,
    });
  };
  const handle = async (request: Request, send: (frame: Frame) => void, signal: AbortSignal) => {
    const { argv } = request;
    const option = (name: string) => {
      const index = argv.indexOf(name);
      return index >= 0
        ? argv[index + 1]
        : argv.find((arg) => arg.startsWith(name + "="))?.slice(name.length + 1);
    };
    const required = (name: string) => {
      const value = option(name);
      if (!value || value.startsWith("--")) {
        throw new Error("missing " + name);
      }
      return value;
    };
    const output = (value: unknown) =>
      send({
        stdout: Buffer.from(
          typeof value === "string" ? value : JSON.stringify(value) + "\n",
        ).toString("base64"),
      });
    const primary = argv[0];
    if (!primary) {
      throw new Error("Backend command required");
    }
    const command = primary === "checkpoint" ? "checkpoint " + argv[1] : primary;
    const receipt: Receipt = { command };
    let code = 0;
    try {
      if ((command === "warmup" || command === "checkpoint fork") && option("--ttl") !== "2h") {
        throw new Error("Managed setup fixture requires its engine-enforced 2h lease");
      }
      if (command === "--version") {
        output("0.81.1\n");
      } else if (command === "warmup") {
        const leaseId = required("--lease-id");
        receipt.leaseId = leaseId;
        await mutate(() => createLease(leaseId, required("--slug"), options.image));
      } else if (command === "inspect" || command === "heartbeat") {
        const leaseId = required("--id");
        receipt.leaseId = leaseId;
        if (command === "inspect") {
          await options.beforeInspect?.(leaseId);
        }
        const container = await requireContainer(leaseId);
        const createdAt = container.Labels[CREATED_LABEL];
        if (!createdAt) {
          throw new Error("Owned lease is missing its creation receipt");
        }
        output({
          id: leaseId,
          state: "running",
          ready: true,
          createdAt,
          ttlSeconds: LEASE_SECONDS,
          expiresAt: new Date(Date.parse(createdAt) + LEASE_SECONDS * 1_000).toISOString(),
        });
      } else if (command === "run") {
        const leaseId = required("--id");
        receipt.leaseId = leaseId;
        if (!argv.includes("--script-stdin") || request.script === undefined) {
          throw new Error("script stdin required");
        }
        receipt.scriptSha256 = hash(Buffer.from(request.script, "base64"));
        code = await guest(
          leaseId,
          { operation: "run", script: request.script, env: request.env },
          (frame) => {
            if (frame.stdout || frame.stderr) {
              send(frame);
            }
          },
          signal,
        );
      } else if (command === "stop") {
        const leaseId = required("--id");
        receipt.leaseId = leaseId;
        await mutate(() => stopLease(leaseId));
      } else if (command === "cp" && request.copy) {
        receipt.leaseId = request.copy.leaseId;
        code = await guest(
          request.copy.leaseId,
          { operation: "write", path: request.copy.path, data: request.copy.data },
          () => {},
          signal,
        );
      } else if (command === "checkpoint create") {
        const leaseId = required("--id");
        const checkpointId = "chk_" + randomUUID().replaceAll("-", "");
        receipt.leaseId = leaseId;
        receipt.checkpointId = checkpointId;
        if (required("--mode") !== "native") {
          throw new Error("native checkpoint required");
        }
        await mutate(async () => {
          await requireContainer(leaseId);
          await podman(
            [
              "commit",
              "--pause=true",
              "--change",
              "LABEL " + OWNER_LABEL + "=" + owner,
              nameFor(leaseId),
              imageFor(checkpointId),
            ],
            false,
            2_700_000,
          );
          if (!(await hasCheckpoint(checkpointId))) {
            throw new Error("committed image unavailable");
          }
        });
        output({
          id: checkpointId,
          kind: "podman-image",
          leaseId,
          native: { state: "available" },
          captureEstablished: true,
        });
      } else if (command === "checkpoint inspect") {
        const checkpointId = argv[2];
        if (!checkpointId) {
          throw new Error("Checkpoint identity required");
        }
        receipt.checkpointId = checkpointId;
        output(
          (await hasCheckpoint(checkpointId))
            ? {
                localState: "metadata_available",
                providerState: "available",
                nextAction: "fork_or_delete",
              }
            : { localState: "missing" },
        );
      } else if (command === "checkpoint fork") {
        const checkpointId = argv[2];
        if (!checkpointId) {
          throw new Error("Checkpoint identity required");
        }
        const leaseId = required("--lease-id");
        const slug = required("--slug");
        receipt.checkpointId = checkpointId;
        receipt.leaseId = leaseId;
        await mutate(async () => {
          if (!(await hasCheckpoint(checkpointId))) {
            throw new Error("checkpoint absent id=" + checkpointId);
          }
          await createLease(leaseId, slug, imageFor(checkpointId));
        });
        output({ checkpointId, leaseId, provider: "external", slug, workdir: "/workspace" });
      } else if (command === "checkpoint delete") {
        const checkpointId = argv[2];
        if (!checkpointId) {
          throw new Error("Checkpoint identity required");
        }
        receipt.checkpointId = checkpointId;
        if (!(await mutate(() => deleteCheckpoint(checkpointId)))) {
          output("checkpoint absent id=" + checkpointId + "\n");
        }
      } else {
        throw new Error("unsupported managed setup command");
      }
    } catch (error) {
      code = 1;
      send({
        stderr: Buffer.from(
          (error instanceof Error ? error.message : "managed setup command failed") + "\n",
        ).toString("base64"),
      });
    }
    await record({ ...receipt, exitCode: code });
    send({ exitCode: code });
  };
  const requests = new Set<Promise<void>>();
  const cancellations = new Set<AbortController>();
  let closing = false;
  const server = net.createServer((socket) => {
    const abort = new AbortController();
    cancellations.add(abort);
    let started = false;
    let settled = false;
    socket.on("error", () => abort.abort());
    socket.on("close", () => {
      if (!settled) {
        abort.abort();
      }
    });
    createInterface({ input: socket }).on("line", (line) => {
      const request = JSON.parse(line);
      if (request.cancel) {
        abort.abort();
        return;
      }
      if (started || closing) {
        socket.destroy();
        return;
      }
      started = true;
      const running = handle(
        request,
        (frame) => {
          if (!socket.destroyed) {
            socket.write(JSON.stringify(frame) + "\n");
          }
        },
        abort.signal,
      ).finally(() => {
        settled = true;
        socket.end();
        requests.delete(running);
        cancellations.delete(abort);
      });
      requests.add(running);
    });
  });
  // /proc/self/fd avoids Linux's 108-byte sockaddr limit for deep worktree roots.
  // Both sides open the same mounted directory; no shared network namespace needed.
  const rootHandle = await open(root, "r");
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen("/proc/self/fd/" + rootHandle.fd + "/backend.sock", resolveListen);
  });
  await chmod(socketPath, 0o600);
  return {
    binaryPath,
    socketPath,
    receipts,
    async readFile(leaseId: string, path: string): Promise<string | undefined> {
      let result: string | undefined;
      const code = await guest(leaseId, { operation: "read", path }, (frame) => {
        if (frame.data !== undefined) {
          result = Buffer.from(frame.data, "base64").toString("utf8");
        }
      });
      if (code !== 0) {
        throw new Error("guest file read failed");
      }
      return result;
    },
    async listResources() {
      return {
        owner,
        containers: (await containers()).map((container) => ({
          name: container.Names[0],
          leaseId: container.Labels[LEASE_LABEL],
          slug: container.Labels[SLUG_LABEL],
          state: container.State,
        })),
        checkpoints: (await checkpointTags()).map((tag) => ({
          checkpointId: tag.slice(tag.lastIndexOf(":") + 1),
          image: tag,
        })),
      };
    },
    async close() {
      closing = true;
      const stopped = new Promise<void>((resolveClose, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolveClose();
          }
        });
      });
      for (const cancellation of cancellations) {
        cancellation.abort();
      }
      await Promise.allSettled(requests);
      await mutate(async () => {
        for (const container of await containers()) {
          const leaseId = container.Labels[LEASE_LABEL];
          if (!leaseId) {
            throw new Error("Owned container lost its lease identity");
          }
          await stopLease(leaseId);
        }
        for (const tag of await checkpointTags()) {
          await deleteCheckpoint(tag.slice(tag.lastIndexOf(":") + 1));
        }
      });
      await stopped;
      await rootHandle.close();
      await rm(socketPath, { force: true });
    },
  };
}
