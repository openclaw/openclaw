import { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getEnvironmentData, threadId, type Worker } from "node:worker_threads";

// Ephemeral Node/Vitest resource handoff, not application persistence. Claims
// survive worker/module death; only the namespace's process owner deletes them.
const OWNER_DIRECTORY = ".vitest-resource-owner";
const ID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function readReceipt(file: string): string {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(128);
    let offset = 0;
    while (offset < buffer.length) {
      const bytes = fs.readSync(fd, buffer, offset, buffer.length - offset, null);
      if (bytes === 0) {
        break;
      }
      offset += bytes;
    }
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function resourceOwner(root: string, identity: string) {
  const directory = path.join(root, OWNER_DIRECTORY);
  const ownerFile = path.join(directory, "owner");
  const claims = path.join(directory, "claims");
  const closedClaims = path.join(directory, "claims.closed");
  const verifyOwner = () => {
    if (readReceipt(ownerFile) !== identity) {
      throw new Error(`Vitest resource owner changed: ${root}`);
    }
  };
  // Admission may atomically move the registry between any two filesystem calls.
  const withClaimFile = <T>(id: string, name: string, access: (file: string) => T): T => {
    try {
      return access(path.join(claims, id, name));
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) {
        throw error;
      }
      return access(path.join(closedClaims, id, name));
    }
  };
  const publishReceipt = (id: string, name: string, value: string) =>
    withClaimFile(id, name, (file) => fs.writeFileSync(file, value, { flag: "wx" }));
  const claimIds = () => withClaimFile("", "", (registry) => fs.readdirSync(registry));
  const claimResource = () => {
    verifyOwner();
    const id = randomUUID();
    const claim = path.join(claims, id);
    // Atomic pending admission, before allocation/spawn. No shared JSON RMW
    // and no deletion-based release: a missing receipt never means success.
    fs.mkdirSync(claim);
    return {
      id,
      release: () => {
        verifyOwner();
        publishReceipt(id, "released", `${identity}:${id}`);
      },
    };
  };
  const settleNativeExit = (
    matchesNativeOwner: (claimant: string) => boolean,
    exited: Promise<boolean>,
    label: string,
  ) => {
    let settled = false;
    return async () => {
      const observedExit = await exited;
      if (settled) {
        return;
      }
      try {
        if (!observedExit) {
          throw new Error(`Native ${label} exit was not confirmed`);
        }
        verifyOwner();
        for (const id of claimIds()) {
          if (!ID_PATTERN.test(id)) {
            continue;
          }
          let claimant: string;
          try {
            claimant = withClaimFile(id, "native-worker", readReceipt);
          } catch (error) {
            if (hasErrorCode(error, "ENOENT")) {
              continue; // General claims cannot settle at another resource's native exit.
            }
            throw error;
          }
          if (!matchesNativeOwner(claimant)) {
            continue;
          }
          const receipt = `${identity}:${id}:${claimant}`;
          try {
            if (withClaimFile(id, "native-exited", readReceipt) !== receipt) {
              throw new Error(`Native ${label} exit receipt changed`);
            }
          } catch (error) {
            if (!hasErrorCode(error, "ENOENT")) {
              throw error;
            }
            // Retry only missing publications from this exact observed native exit.
            publishReceipt(id, "native-exited", receipt);
          }
        }
        settled = true;
      } catch (error) {
        throw new Error(`Failed to record native ${label} exit`, { cause: error });
      }
    };
  };
  const observeNativeWorkerExit = (worker: Worker) => {
    verifyOwner();
    const workerId = worker.threadId;
    if (workerId <= 0) {
      throw new Error("Native resource settlement must observe a live Worker exit");
    }
    return settleNativeExit(
      (claimant) => claimant === `${process.pid}:${workerId}`,
      new Promise<boolean>((resolve) => {
        worker.prependOnceListener("exit", () => resolve(worker.threadId === -1));
      }),
      "Worker",
    );
  };
  const observeNativeProcessExit = (
    child: ChildProcess,
    options: { includeWorkerThreads?: boolean } = {},
  ) => {
    verifyOwner();
    if (
      !(child instanceof ChildProcess) ||
      !child.pid ||
      child.exitCode !== null ||
      child.signalCode !== null
    ) {
      throw new Error("Native resource settlement must observe a live child process close");
    }
    // Default to main-thread claims. A fixture that owns whole-process termination
    // may also join its threads: native process death ends all of those isolates,
    // but never proves completion of a descendant process or a general claim.
    const includeWorkerThreads = options.includeWorkerThreads === true;
    const nativeOwner = `${child.pid}:0`;
    const processOwners = new RegExp(`^${child.pid}:(?:0|[1-9][0-9]*)$`);
    return settleNativeExit(
      (claimant) =>
        includeWorkerThreads ? processOwners.test(claimant) : claimant === nativeOwner,
      new Promise<boolean>((resolve) => {
        child.prependOnceListener("close", () =>
          resolve(child.exitCode !== null || child.signalCode !== null),
        );
      }),
      "process",
    );
  };
  return {
    root,
    identity,
    claim: () => claimResource().release,
    // Transfer cleanup custody before annotation can fail. No native allocation
    // may begin until this returns; failed admission can release an unopened claim.
    claimNativeHandle: (retain: (release: () => void) => void) => {
      const { id, release } = claimResource();
      retain(release);
      publishReceipt(id, "native-worker", `${process.pid}:${threadId}`);
    },
    observeNativeWorkerExit,
    observeNativeProcessExit,
    joinNativeWorkerExit: (worker: Worker) => observeNativeWorkerExit(worker)(),
    assertReleased() {
      verifyOwner();
      const registry = fs.existsSync(closedClaims) ? closedClaims : claims;
      // The creator expects this registry. Missing/unreadable metadata is not
      // an empty set, including after all workers have exited successfully.
      for (const id of claimIds()) {
        try {
          if (
            ID_PATTERN.test(id) &&
            withClaimFile(id, "released", readReceipt) === `${identity}:${id}`
          ) {
            continue;
          }
        } catch {
          // An explicit termination may instead have joined this exact native owner.
        }
        try {
          const nativeOwner = withClaimFile(id, "native-worker", readReceipt);
          if (
            ID_PATTERN.test(id) &&
            /^[1-9][0-9]*:(?:0|[1-9][0-9]*)$/.test(nativeOwner) &&
            withClaimFile(id, "native-exited", readReceipt) === `${identity}:${id}:${nativeOwner}`
          ) {
            continue;
          }
        } catch {
          // Retain on missing, corrupt, or unreadable completion evidence.
        }
        throw new Error(`Unreleased Vitest resource claim: ${path.join(registry, id)}`);
      }
    },
  };
}

export function createVitestResourceOwner(root: string) {
  const identity = randomUUID();
  const directory = path.join(root, OWNER_DIRECTORY);
  fs.mkdirSync(directory);
  fs.mkdirSync(path.join(directory, "claims"));
  fs.writeFileSync(path.join(directory, "owner"), identity, { flag: "wx" });
  const owner = resourceOwner(root, identity);
  let admissionClosed = false;
  return {
    ...owner,
    closeAndAssertReleased() {
      const claims = path.join(directory, "claims");
      const closedClaims = path.join(directory, "claims.closed");
      if (!admissionClosed) {
        fs.renameSync(claims, closedClaims);
        admissionClosed = true;
      }
      owner.assertReleased();
    },
  };
}

/** Discover only explicit containing owners, including canonical TMP symlinks. */
export function findVitestResourceOwner(root = tmpdir()) {
  let current = path.resolve(root);
  while (true) {
    try {
      // A command may create its own TMP leaf; find the existing containing
      // owner without making that directory or changing command admission.
      current = fs.realpathSync(current);
      fs.lstatSync(path.join(current, OWNER_DIRECTORY));
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) {
        throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        return undefined;
      }
      current = parent;
      continue;
    }
    const identity = readReceipt(path.join(current, OWNER_DIRECTORY, "owner"));
    if (!ID_PATTERN.test(identity)) {
      throw new Error(`Invalid Vitest resource owner: ${current}`);
    }
    return resourceOwner(current, identity);
  }
}

export type VitestResourceOwner = NonNullable<ReturnType<typeof findVitestResourceOwner>>;
type VitestResourceOwnerDescriptor = { root: string; identity: string };
export type VitestResourceContextDescriptor =
  | { kind: "absent" }
  | {
      kind: "owned";
      environment: Readonly<Record<string, string>>;
      owners: readonly VitestResourceOwnerDescriptor[];
      nodeOption: string;
      productionRuntimeDirectory: string;
    };
export type VitestResourceContext =
  | { kind: "absent" }
  | {
      kind: "owned";
      environment: Readonly<Record<string, string>>;
      owners: readonly VitestResourceOwner[];
      nodeOption: string;
      productionRuntimeDirectory: string;
    };

export const VITEST_RESOURCE_CONTEXT_KEY = "openclaw.vitest-resource-context";
export const VITEST_RESOURCE_CONTEXT_SYMBOL = Symbol.for(VITEST_RESOURCE_CONTEXT_KEY);

function isPropertyRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
}

function isVitestResourceEnvironment(value: unknown): value is Readonly<Record<string, string>> {
  return (
    isPropertyRecord(value) &&
    !Array.isArray(value) &&
    Reflect.ownKeys(value).every((key) => typeof value[key] === "string")
  );
}

function isResourceOwnerDescriptor(value: unknown): value is VitestResourceOwnerDescriptor {
  return (
    isPropertyRecord(value) &&
    typeof value["root"] === "string" &&
    typeof value["identity"] === "string"
  );
}

function isResourceOwnerDescriptorArray(
  value: unknown,
): value is readonly VitestResourceOwnerDescriptor[] {
  return Array.isArray(value) && value.every(isResourceOwnerDescriptor);
}

function readVitestResourceContextDescriptor(): VitestResourceContextDescriptor | undefined {
  const published: unknown = Reflect.get(globalThis, VITEST_RESOURCE_CONTEXT_SYMBOL);
  const value = published ?? getEnvironmentData(VITEST_RESOURCE_CONTEXT_KEY);
  if (value === undefined) {
    return undefined;
  }
  if (!isPropertyRecord(value)) {
    throw new Error("Invalid Vitest resource context descriptor");
  }
  if (value["kind"] === "absent") {
    return { kind: "absent" };
  }
  const environment = value["environment"];
  const nodeOption = value["nodeOption"];
  const owners = value["owners"];
  const productionRuntimeDirectory = value["productionRuntimeDirectory"];
  if (
    value["kind"] !== "owned" ||
    !isVitestResourceEnvironment(environment) ||
    !isResourceOwnerDescriptorArray(owners) ||
    typeof nodeOption !== "string" ||
    typeof productionRuntimeDirectory !== "string"
  ) {
    throw new Error("Invalid Vitest resource context descriptor");
  }
  return {
    kind: "owned",
    environment,
    nodeOption,
    owners,
    productionRuntimeDirectory,
  };
}

export function getVitestResourceContext(): VitestResourceContext | undefined {
  const descriptor = readVitestResourceContextDescriptor();
  if (!descriptor || descriptor.kind === "absent") {
    return descriptor;
  }
  const owners = descriptor.owners.map((entry) => {
    const canonicalRoot = fs.realpathSync(entry.root);
    const owner = findVitestResourceOwner(canonicalRoot);
    if (owner?.root !== canonicalRoot || owner.identity !== entry.identity) {
      throw new Error(`Invalid Vitest resource context owner: ${entry.root}`);
    }
    return owner;
  });
  return {
    kind: "owned",
    environment: { ...descriptor.environment },
    nodeOption: descriptor.nodeOption,
    owners,
    productionRuntimeDirectory: descriptor.productionRuntimeDirectory,
  };
}

/** Retain retryable publication of an exact native exit, separate from successful close. */
export function captureResourceOwnedNativeWorkerExit(worker: Worker) {
  // An already-exited (or non-native test double) Worker cannot attest a new native exit.
  const context = worker.threadId > 0 ? getVitestResourceContext() : undefined;
  if (context?.kind !== "owned") {
    return undefined;
  }
  const settlements = context.owners.map((owner) => owner.observeNativeWorkerExit(worker));
  return async () => {
    await Promise.all(settlements.map((settle) => settle()));
  };
}

/** Observe a live native child before cancellation; settlement waits for its close event. */
export function captureResourceOwnedNativeProcessExit(
  child: ChildProcess,
  options: { includeWorkerThreads?: boolean } = {},
) {
  const context = getVitestResourceContext();
  if (context?.kind !== "owned") {
    return undefined;
  }
  const settlements = context.owners.map((owner) => owner.observeNativeProcessExit(child, options));
  return async () => {
    await Promise.all(settlements.map((settle) => settle()));
  };
}

/** Join an explicitly terminated native owner; general descendant claims remain pending. */
export async function terminateResourceOwnedNativeWorker(worker: Worker): Promise<number> {
  const settle = captureResourceOwnedNativeWorkerExit(worker);
  const [code] = await Promise.all([worker.terminate(), settle?.()]);
  return code;
}

/**
 * Preserve the validated owned-test context across a repository-owned Node
 * child. The environment key names are supplied by the trusted preload, so
 * production modules do not parse or inventory the test-only transport.
 *
 * Returns the keys that an allowlisting process boundary must forward.
 */
export function applyVitestResourceContextToChildEnv(env: NodeJS.ProcessEnv): readonly string[] {
  const context = getVitestResourceContext();
  if (!context || context.kind === "absent") {
    return [];
  }
  const entries = Object.entries(context.environment);
  const suppliedEntries = entries.filter(([key]) => env[key] !== undefined);
  if (suppliedEntries.length > 0 && suppliedEntries.length !== entries.length) {
    throw new Error("Incomplete Vitest resource context in child environment");
  }
  for (const [key, value] of suppliedEntries) {
    if (env[key] !== value) {
      throw new Error(`Conflicting Vitest resource context in child environment: ${key}`);
    }
  }
  const nodeOptions = composeVitestResourceContextNodeOptions(env.NODE_OPTIONS);
  for (const [key, value] of entries) {
    env[key] = value;
  }
  env.NODE_OPTIONS = nodeOptions;
  return [...entries.map(([key]) => key), "NODE_OPTIONS"];
}

export function composeVitestResourceContextNodeOptions(
  requested: string | undefined,
  trustedNodeOption?: string,
): string | undefined {
  const context = getVitestResourceContext();
  const nodeOption =
    trustedNodeOption ?? (context?.kind === "owned" ? context.nodeOption : undefined);
  if (!nodeOption) {
    return requested;
  }
  const requestedOptions = parseNodeOptions(requested);
  if (!requestedOptions) {
    throw new Error("Invalid NODE_OPTIONS in owned Vitest child environment");
  }
  assertNoUnsafeNodeStartupHooks(requestedOptions, "NODE_OPTIONS");
  const canonicalOptions = requestedOptions
    .filter((option) => option !== nodeOption)
    .map(quoteNodeOption);
  return [nodeOption, ...canonicalOptions].join(" ");
}

/**
 * Reject Node hooks that run before an ordinary `--import` preload. Keep this
 * aligned with the resolver-hook classification in entry.esm-resolve-fast-path.
 */
export function assertVitestResourceContextSafeNodeArgv(
  args: readonly string[],
  declaredEntryIndex: number | undefined,
): void {
  if (args.length === 0 && declaredEntryIndex === undefined) {
    return;
  }
  const entryIndex =
    declaredEntryIndex ?? (args[0] !== undefined && !args[0].startsWith("-") ? 0 : undefined);
  if (entryIndex === undefined) {
    throw new Error("Owned Vitest Node child requires an explicit entry boundary");
  }
  if (!Number.isSafeInteger(entryIndex) || entryIndex < 0 || entryIndex >= args.length) {
    throw new Error("Invalid owned Vitest Node child entry boundary");
  }
  const entry = args[entryIndex] ?? "";
  const entryName = normalizeNodeOptionName(entry);
  if (
    entry !== "--" &&
    entry !== "-" &&
    entry.startsWith("-") &&
    !["-e", "--eval", "-p", "--print"].includes(entryName) &&
    !(/^-[ep].+/u.test(entryName) && !entryName.startsWith("--"))
  ) {
    throw new Error("Invalid owned Vitest Node child entry boundary");
  }
  assertNoUnsafeNodeStartupHooks(args.slice(0, entryIndex), "Node argv");
  if (entry !== "--" && entry !== "-" && entry.startsWith("-")) {
    // Eval/print do not end Node option parsing (print may also omit its source).
    // Keep hook-shaped literal operands behind an explicit `--`; do not duplicate
    // Node's evolving flag-arity table to guess where an eval argument begins.
    const tail = args.slice(entryIndex + 1);
    const separator = tail.indexOf("--");
    assertNoUnsafeNodeStartupHooks(separator < 0 ? tail : tail.slice(0, separator), "Node argv");
  }
}

// Node's NODE_OPTIONS grammar uses literal-space delimiters, double quotes,
// and backslash escapes only inside quotes.
function parseNodeOptions(value: string | undefined): string[] | undefined {
  const tokens: string[] = [];
  let token = "";
  let tokenStarted = false;
  let inQuotes = false;
  const source = value ?? "";
  for (let index = 0; index < source.length; index += 1) {
    let char = source.charAt(index);
    if (char === "\\" && inQuotes) {
      index += 1;
      if (index >= source.length) {
        return undefined;
      }
      char = source.charAt(index);
    } else if (char === " " && !inQuotes) {
      if (tokenStarted) {
        tokens.push(token);
        token = "";
        tokenStarted = false;
      }
      continue;
    } else if (char === '"') {
      inQuotes = !inQuotes;
      tokenStarted = true;
      continue;
    }
    tokenStarted = true;
    token += char;
  }
  if (inQuotes) {
    return undefined;
  }
  if (tokenStarted) {
    tokens.push(token);
  }
  return tokens;
}

// Complete Node startup surfaces that can evaluate user code before an
// ordinary `--import` preload:
// - require preloads run in the earlier CommonJS preload phase;
// - loader modules are initialized by the ESM loader before application imports;
// - startup config files can inject those earlier preload/loader options; and
// - snapshot deserialization callbacks run while the isolate is restored.
const EARLY_NODE_STARTUP_HOOK_OPTIONS = new Set([
  "--loader",
  "--experimental-loader",
  "--experimental-config-file",
  "--experimental-default-config-file",
  "--snapshot-blob",
]);

function normalizeNodeOptionName(option: string): string {
  return (option.split("=", 1)[0] ?? "").replaceAll("_", "-");
}

function classifyUnsafeNodeStartupHook(
  option: string,
): "require" | "loader/config" | "snapshot" | undefined {
  const name = normalizeNodeOptionName(option);
  if (name === "--require" || name === "-r" || (name.startsWith("-r") && name.length > 2)) {
    return "require";
  }
  if (EARLY_NODE_STARTUP_HOOK_OPTIONS.has(name)) {
    return name === "--snapshot-blob" ? "snapshot" : "loader/config";
  }
  return undefined;
}

function assertNoUnsafeNodeStartupHooks(options: readonly string[], source: string): void {
  for (const option of options) {
    const hook = classifyUnsafeNodeStartupHook(option);
    if (hook) {
      throw new Error(`${source} ${hook} hooks are unsafe in owned Vitest child environments`);
    }
  }
}

function quoteNodeOption(option: string): string {
  if (option && !/[ "]/u.test(option)) {
    return option;
  }
  return `"${option.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
