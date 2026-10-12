import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

const networkOperations = new Set([
  "clone",
  "fetch",
  "pull",
  "push",
  "ls-remote",
  "fetch-pack",
  "send-pack",
  "http-fetch",
  "http-push",
]);
const valueOptions = new Set([
  "-b",
  "--branch",
  "-o",
  "--origin",
  "--upload-pack",
  "--receive-pack",
  "--exec",
  "--depth",
  "--shallow-since",
  "--shallow-exclude",
  "--filter",
  "--reference",
  "--reference-if-able",
  "--separate-git-dir",
  "--template",
  "--config",
  "-c",
  "--server-option",
  "--push-option",
  "--upload-pack",
  "--refmap",
  "--jobs",
  "-j",
  "--negotiation-tip",
  "--repo",
]);

function operands(args) {
  const result = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") return [...result, ...args.slice(index + 1)];
    if (arg.startsWith("--repo=")) result.push(arg.slice(7));
    else if (arg === "--repo") result.push(args[++index]);
    else if (valueOptions.has(arg)) index++;
    else if (!arg.startsWith("-")) result.push(arg);
  }
  return result;
}

/** Resolve effective URLs through Git's metadata APIs, never a network probe. */
export function checkGitTestCommand({
  args,
  file,
  options,
  spawnSync,
  isGitHubDestination,
  block,
}) {
  let index = 0;
  while (args[index]?.startsWith("-")) {
    const option = args[index++];
    if (
      [
        "-C",
        "-c",
        "--git-dir",
        "--work-tree",
        "--namespace",
        "--config-env",
        "--exec-path",
      ].includes(option)
    )
      index++;
  }
  const prefix = args.slice(0, index);
  const operation = args[index];
  const rest = args.slice(index + 1);
  const positional = operands(rest);
  const subOperation = positional[0];
  if (operation === "ls-remote" && rest.includes("--get-url")) return;
  const submodule = operation === "submodule" && ["add", "update"].includes(subOperation);
  const remoteNetwork =
    operation === "remote" &&
    (["update", "prune"].includes(subOperation) ||
      (subOperation === "show" && !rest.includes("-n")) ||
      (subOperation === "set-head" && rest.some((arg) => arg === "-a" || arg === "--auto")) ||
      (subOperation === "add" && rest.some((arg) => /^-[^-]*f/u.test(arg) || arg === "--fetch")));
  const archive =
    operation === "archive" &&
    rest.some((arg) => arg === "--remote" || arg.startsWith("--remote="));
  const maintenance = operation === "maintenance" && subOperation === "run";
  if (!networkOperations.has(operation) && !submodule && !remoteNetwork && !archive && !maintenance)
    return;

  // Transport plumbing does not share porcelain URL-selection semantics.
  if (
    ["fetch-pack", "send-pack", "http-fetch", "http-push"].includes(operation) &&
    rest.some(isGitHubDestination)
  )
    block("github-git-destination");

  const metadata = (command, extraPrefix = []) => {
    const result = spawnSync(file, [...prefix, ...extraPrefix, ...command], {
      cwd: options.cwd,
      env: options.env,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    return result.status === 0 && !result.error
      ? result.stdout.trim().split("\n").filter(Boolean)
      : [];
  };
  if (maintenance) {
    const tasks = rest.filter((arg) => arg.startsWith("--task="));
    if (tasks.length && !tasks.includes("--task=prefetch")) return;
    // Git automatically runs local GC after commits. Only enabled prefetch or
    // explicit/scheduled prefetch work can select remote destinations here.
    if (
      !tasks.length &&
      !rest.some((arg) => arg.startsWith("--schedule")) &&
      metadata(["config", "--bool", "maintenance.prefetch.enabled"])[0] !== "true"
    )
      return;
  }
  const recursionDisabled =
    ["push", "fetch", "pull"].includes(operation) && rest.includes("--recurse-submodules=no");
  if (
    (submodule && subOperation === "update") ||
    rest.some(
      (arg) =>
        arg === "--recursive" ||
        (/^--recurse-submodules(?:=|$)/u.test(arg) &&
          !(recursionDisabled && arg === "--recurse-submodules=no")),
    )
  ) {
    block("unresolved-git-submodules");
  }
  const modules = metadata(["rev-parse", "--path-format=absolute", "--git-path", "modules"])[0];
  if (modules && existsSync(modules) && !recursionDisabled) block("unresolved-git-submodules");

  const push = operation === "push" || operation === "send-pack" || operation === "http-push";
  const remotes = metadata(["remote"]);
  const resolve = (destination, literal = false) => {
    if (destination && !literal && remotes.includes(destination)) {
      return metadata(["remote", "get-url", ...(push ? ["--push"] : []), "--all", destination]);
    }
    if (destination && (push || literal)) {
      const remote = `openclaw-test-${randomUUID()}`;
      return metadata(
        ["remote", "get-url", ...(push ? ["--push"] : []), "--all", remote],
        ["-c", `remote.${remote}.url=${destination}`],
      );
    }
    return metadata(["ls-remote", "--get-url", ...(destination ? ["--", destination] : [])]);
  };
  let destinations;
  if (remoteNetwork) {
    if (subOperation === "add") destinations = resolve(positional[2], true);
    else if (subOperation !== "update" && positional[1]) destinations = resolve(positional[1]);
    else destinations = remotes.flatMap((remote) => resolve(remote));
  } else if (
    maintenance ||
    (push && !positional[0]) ||
    (rest.includes("--all") && operation === "fetch")
  ) {
    destinations = remotes.flatMap((remote) => resolve(remote));
  } else if (archive) {
    const option = rest.findIndex((arg) => arg === "--remote" || arg.startsWith("--remote="));
    destinations = resolve(
      rest[option] === "--remote" ? rest[option + 1] : rest[option].slice(9),
      true,
    );
  } else if (submodule) destinations = resolve(positional[1], true);
  else destinations = resolve(positional[0], operation === "clone");

  if (destinations.some(isGitHubDestination)) block("github-git-destination");
  // Invalid/unsupported Git forms retain Git's own errors. Every admitted native
  // Git child also has file-only transport, including implicit promisor fetches.
}
