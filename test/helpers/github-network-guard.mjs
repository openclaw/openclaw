import { AsyncLocalStorage } from "node:async_hooks";
import childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import workerThreads, { threadId } from "node:worker_threads";
import { Agent as UndiciAgent, Dispatcher1Wrapper, getGlobalDispatcher } from "undici";
import undiciSymbols from "undici/lib/core/symbols.js";
import {
  guardNativeHttpArgs,
  inspectTestShellSource,
  readTestShellSource,
  unwrapTestEnvCommand,
} from "./github-network-command.mjs";
import { checkGitTestCommand } from "./github-network-git.mjs";

const reportKey = Symbol.for("openclaw.test.githubNetworkReport");
// The pinned Client/Pool classes expose no public bound-origin accessor. Read the
// dependency's authoritative symbol before their custom connector can hide it.
const undiciOrigin = undiciSymbols.kUrl;
if (typeof undiciOrigin !== "symbol") {
  throw new Error("GitHub test guard could not locate Undici's bound-origin symbol");
}
let reportDirectory = process.env.OPENCLAW_TEST_GITHUB_REPORT_DIR;
const report = (process[reportKey] ??= {
  id: randomUUID(),
  incidental: 0,
  negativeControl: 0,
  omittedAttributions: 0,
  attempts: new Map(),
  controls: new AsyncLocalStorage(),
  context: () => ({
    file: process.env.OPENCLAW_TEST_GITHUB_FILE ?? "<child/config>",
    test: process.env.OPENCLAW_TEST_GITHUB_TEST ?? "<child/config>",
    negativeControl: process.env.OPENCLAW_TEST_GITHUB_NEGATIVE_CONTROL === "1",
  }),
});

// Snapshots are bounded even when a leaking test retries. Write each blocked attempt
// before throwing so worker crashes do not erase the evidence. No URLs or argv are logged.
function writeReport() {
  if (reportDirectory) {
    writeFileSync(
      path.join(reportDirectory, `${report.id}-${threadId}.json`),
      JSON.stringify({
        pid: process.pid,
        threadId,
        incidental: report.incidental,
        negativeControl: report.negativeControl,
        omittedAttributions: report.omittedAttributions,
        attempts: [...report.attempts.values()],
      }) + "\n",
    );
  }
}

export function setGitHubTestContext(context) {
  report.context = context;
}

/** Mark only a deliberate negative-control action, including its child transports. */
export function withGitHubNegativeControl(action) {
  return report.controls.run({ ...report.context(), negativeControl: true }, action);
}

function currentContext() {
  return report.controls.getStore() ?? report.context();
}

export function githubNetworkAttemptCounts() {
  return { incidental: report.incidental, negativeControl: report.negativeControl };
}

const guardKey = Symbol.for("openclaw.test.githubNetworkGuard");
function resolveGuardSource() {
  const source = import.meta.url.startsWith("file:")
    ? fileURLToPath(import.meta.url)
    : import.meta.filename;
  const ownsFixtures = (file) =>
    typeof file === "string" &&
    path.isAbsolute(file) &&
    existsSync(file) &&
    existsSync(path.resolve(path.dirname(file), "../fixtures/forbid-github/transport.mjs"));
  if (ownsFixtures(source)) {
    return source;
  }
  // JSDOM's Vite runtime presents an HTTP module URL; child preloads still need the source file.
  for (let directory = process.cwd(); ; directory = path.dirname(directory)) {
    const candidate = path.join(directory, "test/helpers/github-network-guard.mjs");
    if (ownsFixtures(candidate)) {
      return candidate;
    }
    if (path.dirname(directory) === directory) {
      throw new Error("GitHub test guard source and command fixtures could not be resolved");
    }
  }
}
const guardSource = resolveGuardSource();
const repoRoot = path.resolve(path.dirname(guardSource), "../..");
const preload = path.join(path.dirname(guardSource), "github-network-preload.cjs");
const preloadOption = `--require=${JSON.stringify(preload)}`;
const marker = "OPENCLAW_TEST_GITHUB_NETWORK_GUARD";
const tempRootKey = "OPENCLAW_TEST_GITHUB_FIXTURE_ROOT";
const hostsKey = "OPENCLAW_TEST_GITHUB_HOSTS";
const fixtureRoot = process.env[tempRootKey] || tmpdir();
const inheritedHosts = (process.env[hostsKey] ?? "").split(",").filter(Boolean);
const inheritedCommands = process.env.OPENCLAW_TEST_GITHUB_COMMAND_DIR;
let blockedCommands = inheritedCommands;
const transportCommands = new Set([
  "gh",
  "curl",
  "wget",
  "git",
  "ssh",
  "invoke-webrequest",
  "invoke-restmethod",
  "iwr",
  "irm",
]);

function envValue(env, name) {
  const key =
    process.platform === "win32"
      ? Object.keys(env)
          .toSorted()
          .find((candidate) => candidate.toUpperCase() === name.toUpperCase())
      : name;
  return key === undefined ? undefined : env[key];
}

function configuredHosts(env) {
  return [...new Set([...inheritedHosts, envValue(env, "GH_HOST"), process.env.GH_HOST])].filter(
    Boolean,
  );
}

export function blockGitHubTestCommand(transport = "unresolved-command") {
  const context = currentContext();
  const kind = context.negativeControl ? "negativeControl" : "incidental";
  report[kind]++;
  const file = context.file
    ? path.isAbsolute(context.file)
      ? path.relative(repoRoot, context.file)
      : context.file
    : "<collection>";
  const test = context.test ?? "<collection>";
  const key = JSON.stringify([kind, transport, file, test]);
  const previous = report.attempts.get(key);
  if (previous) {
    previous.count++;
  } else if (report.attempts.size < 100) {
    report.attempts.set(key, {
      kind,
      transport,
      file,
      test,
      count: 1,
      stack: new Error().stack
        ?.split("\n")
        .slice(2, 8)
        .map((line) => line.replaceAll(process.cwd(), ".")),
    });
  } else {
    report.omittedAttributions++;
  }
  writeReport();
  throw new Error(
    "GitHub network access is forbidden in ordinary tests; use a mocked HTTP transport or a temporary gh fixture",
  );
}

export function githubTestHostPolicy(env = process.env) {
  return {
    suffixes: ["github.com", "githubusercontent.com", "ghe.com"],
    exact: configuredHosts(env),
  };
}

export function isGitHubTestHost(host, env = process.env) {
  const normalized = String(host ?? "")
    .toLowerCase()
    .replace(/^\[|\]$|\.$/gu, "");
  return (
    githubTestHostPolicy(env).suffixes.some(
      (suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`),
    ) ||
    githubTestHostPolicy(env).exact.some(
      (configuredHost) => normalized === configuredHost.toLowerCase().replace(/\.$/u, ""),
    )
  );
}
const isGitHubHost = isGitHubTestHost;

function hasGitHubDestination(value, env) {
  const text = String(value).replace(/^(?:host|:authority):\s*/iu, "");
  for (const token of text.split(/[\s"'=]+/u)) {
    const scpHost = /^(?:[^/@:]+@)?(\[[^\]]+\]|[^/:]+):/u.exec(token)?.[1];
    if (scpHost && isGitHubHost(scpHost, env)) {
      return true;
    }
    const url = URL.parse(token.includes("://") ? token : `https://${token}`);
    if (url && isGitHubHost(url.hostname, env)) {
      return true;
    }
  }
  for (const match of text.matchAll(/(?:[a-z][a-z\d+.-]*:\/\/|git@)[^\s"'<>]+/giu)) {
    const raw = match[0];
    const url = URL.parse(raw.startsWith("git@") ? `ssh://${raw.replace(":", "/")}` : raw);
    if (url && isGitHubHost(url.hostname, env)) {
      return true;
    }
  }
  return false;
}

function resolveGitHubGuardExecutable(command, env, cwd) {
  const directoryRoot = cwd instanceof URL ? fileURLToPath(cwd) : (cwd ?? process.cwd());
  if (path.isAbsolute(command) || command.includes("/") || command.includes(path.sep)) {
    return path.resolve(directoryRoot, command);
  }
  const lookupPath =
    envValue(env, "PATH") ??
    (process.platform === "win32" ? (envValue(process.env, "PATH") ?? "") : "/usr/bin:/bin");
  const directories = lookupPath.split(path.delimiter);
  if (process.platform === "win32") {
    directories.unshift("");
  }
  for (const directory of directories) {
    if (path.resolve(directoryRoot, directory) === blockedCommands) {
      continue;
    }
    for (const suffix of process.platform === "win32"
      ? ["", ".com", ".exe", ".cmd", ".bat"]
      : [""]) {
      const candidate = path.resolve(directoryRoot, directory, command + suffix);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

function isTemporaryFixture(file) {
  if (!file || !existsSync(file)) {
    return false;
  }
  const relative = path.relative(realpathSync(fixtureRoot), realpathSync(file));
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return false;
  }
  // Native gh can read the user's keychain even when HOME and token variables are isolated.
  return (
    (process.platform === "win32" && /\.(?:cmd|bat)$/iu.test(file)) ||
    /^#![^\r\n]+/u.test(readFileSync(file, "utf8").slice(0, 256))
  );
}

function ensureCommandShims() {
  if (blockedCommands) {
    return blockedCommands;
  }
  // Capture the underlying executables before a test prepends its own wrappers.
  // A fixture may legitimately retain `command -v git` and delegate to it later.
  const executables = Object.fromEntries(
    ["gh", "git", "curl", "wget", "ssh"].map((command) => [
      command,
      resolveGitHubGuardExecutable(command, process.env, process.cwd()),
    ]),
  );
  blockedCommands = mkdtempSync(path.join(reportDirectory ?? tmpdir(), "github-commands-"));
  const config = path.join(blockedCommands, "transport.json");
  writeFileSync(
    config,
    JSON.stringify({
      guardSource,
      executables,
      defaults: {
        [marker]: "1",
        [tempRootKey]: fixtureRoot,
        [hostsKey]: configuredHosts(process.env).join(","),
        OPENCLAW_TEST_GITHUB_COMMAND_DIR: blockedCommands,
        OPENCLAW_TEST_GITHUB_REPORT_DIR: reportDirectory,
        OPENCLAW_TEST_GITHUB_FILE: "<sanitized-child>",
        OPENCLAW_TEST_GITHUB_TEST: "<sanitized-child>",
      },
    }),
  );
  const transport = path.resolve(
    path.dirname(guardSource),
    "../fixtures/forbid-github/transport.mjs",
  );
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  for (const command of Object.keys(executables)) {
    writeFileSync(
      path.join(blockedCommands, command),
      `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(transport)} ${quote(config)} ${command} "$@"\n`,
      { mode: 0o755 },
    );
    writeFileSync(
      path.join(blockedCommands, `${command}.cmd`),
      `@"${process.execPath}" "${transport}" "${config}" ${command} %*\r\n`,
    );
  }
  return blockedCommands;
}

function guardedPath(env, cwd) {
  ensureCommandShims();
  const defaultPath =
    process.platform === "win32" ? (envValue(process.env, "PATH") ?? "") : "/usr/bin:/bin";
  const directories = (envValue(env, "PATH") ?? defaultPath)
    .split(path.delimiter)
    .filter((directory) => directory !== blockedCommands);
  const firstRealGh = directories.findIndex((directory) =>
    ["gh", "git", "curl", "wget", "ssh"].some((command) => {
      const file = resolveGitHubGuardExecutable(command, { PATH: directory }, cwd);
      return file && !isTemporaryFixture(file);
    }),
  );
  directories.splice(firstRealGh < 0 ? directories.length : firstRealGh, 0, blockedCommands);
  return directories.join(path.delimiter);
}

// WebIDL dictionaries read inherited members and getters in their own order.
// Forward those reads rather than spreading options or reading dispatcher twice.
function mapRequestDispatcher(init, selectDispatcher) {
  if (init != null && typeof init !== "object" && typeof init !== "function") {
    return init;
  }
  return new Proxy(
    {},
    {
      get(_target, key) {
        const value = init?.[key];
        return key === "dispatcher" ? selectDispatcher(value) : value;
      },
    },
  );
}

/** Block real GitHub transports, including Node children that replace their environment. */
export function installGitHubNetworkGuard() {
  reportDirectory ??= process.env.OPENCLAW_TEST_GITHUB_REPORT_DIR;
  if (globalThis[guardKey]) {
    return globalThis[guardKey];
  }
  ensureCommandShims();
  const originalFetch = globalThis.fetch;
  const OriginalRequest = globalThis.Request;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Saved for Reflect.apply with the actual Request receiver and exact restoration.
  const originalRequestClone = OriginalRequest?.prototype.clone;
  const requestDispatchers = new WeakMap();
  const unknownDispatcher = Symbol("untracked Request dispatcher");
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Saved for Reflect.apply with the actual Socket receiver and exact restoration.
  const originalConnect = net.Socket.prototype.connect;
  const originalTlsConnect = tls.connect;
  const originalWorker = workerThreads.Worker;
  // eslint-disable-next-line no-underscore-dangle -- Node's shared request-header serialization boundary has no public admission hook.
  const originalStoreHeader = http.ClientRequest.prototype._storeHeader;
  const originalStoreHeaderDescriptor = Object.getOwnPropertyDescriptor(
    http.ClientRequest.prototype,
    "_storeHeader",
  );
  const originalHttp = [http, https].map((module) => ({
    module,
    request: module.request,
    get: module.get,
  }));
  // Node's bundled Undici may already own the global dispatcher. Cover its existing
  // dispatch owner as well as the installed package's shared Agent/Pool/Client owner.
  const undiciDispatchOwners = new Set();
  for (const dispatcher of [UndiciAgent.prototype, getGlobalDispatcher()]) {
    let owner = dispatcher;
    while (owner && !Object.hasOwn(owner, "dispatch")) {
      owner = Object.getPrototypeOf(owner);
    }
    if (!owner || typeof Object.getOwnPropertyDescriptor(owner, "dispatch")?.value !== "function") {
      throw new Error("GitHub test guard could not locate Undici's dispatch owner");
    }
    undiciDispatchOwners.add(owner);
  }
  const originalUndiciDispatches = [...undiciDispatchOwners].map((owner) => ({
    owner,
    descriptor: Object.getOwnPropertyDescriptor(owner, "dispatch"),
  }));
  const methods = ["execFile", "execFileSync", "spawn", "spawnSync", "fork", "exec", "execSync"];
  const originals = new Map(methods.map((name) => [name, childProcess[name]]));
  const checkCommand = (command, args, options, shellText = "") => {
    const env = options.env ?? process.env;
    const file = resolveGitHubGuardExecutable(command, env, options.cwd);
    const name = path
      .basename(command)
      .toLowerCase()
      .replace(/\.(?:exe|com|cmd|bat)$/u, "");
    if (name === "gh" || command === envValue(env, "OPENCLAW_GH_BIN")) {
      if (!file || !isTemporaryFixture(file)) {
        blockGitHubTestCommand("native-gh");
      }
    } else if (transportCommands.has(name)) {
      if (name === "git") {
        if (!isTemporaryFixture(file)) {
          checkGitTestCommand({
            args,
            file: file ?? command,
            options: { ...options, env },
            spawnSync: originals.get("spawnSync"),
            isGitHubDestination: (value) => hasGitHubDestination(value, env),
            block: blockGitHubTestCommand,
          });
        }
      } else if (
        hasGitHubDestination(shellText, env) ||
        args.some((arg) => hasGitHubDestination(arg, env))
      ) {
        blockGitHubTestCommand("github-command");
      }
    }
    return isTemporaryFixture(file)
      ? args
      : guardNativeHttpArgs(name, args, blockGitHubTestCommand, Boolean(shellText));
  };
  const childEnvironment = (env, cwd) => {
    const nodeOptions = envValue(env, "NODE_OPTIONS") ?? "";
    const childEnv = { ...env };
    // GitHub CLI can also use its config directory or an SSH agent. HTTP token
    // fixtures must mock their transport; credentials never accompany a real child.
    // Startup hooks can execute ambient shell code before the inspected command.
    for (const key of Object.keys(childEnv)) {
      if (
        /^(?:GH_|GITHUB_).*(?:TOKEN|SECRET|PASSWORD|KEY)$/iu.test(key) ||
        key.toUpperCase().startsWith("BASH_FUNC_") ||
        [
          "GH_CONFIG_DIR",
          "SSH_AUTH_SOCK",
          "GIT_ASKPASS",
          "SSH_ASKPASS",
          "BASH_ENV",
          "ENV",
          "ZDOTDIR",
        ].includes(key.toUpperCase())
      ) {
        delete childEnv[key];
      }
    }
    const context = currentContext();
    if (process.platform === "win32") {
      for (const key of Object.keys(childEnv)) {
        if (key.toUpperCase() === "PATH") {
          delete childEnv[key];
        }
      }
    }
    return {
      ...childEnv,
      // Native Git can fetch implicitly (for example promisor objects), including
      // from shell fixtures. Only file transport belongs in an ordinary test.
      GIT_ALLOW_PROTOCOL: "file",
      PATH: guardedPath(env, cwd),
      // Removing ZDOTDIR would make Zsh read HOME/.zshenv before our inspected command.
      ZDOTDIR: blockedCommands,
      [marker]: "1",
      OPENCLAW_TEST_GITHUB_COMMAND_DIR: blockedCommands,
      [tempRootKey]: fixtureRoot,
      [hostsKey]: configuredHosts(env).join(","),
      OPENCLAW_TEST_GITHUB_REPORT_DIR: reportDirectory,
      OPENCLAW_TEST_GITHUB_FILE: context.file,
      OPENCLAW_TEST_GITHUB_TEST: context.test,
      OPENCLAW_TEST_GITHUB_NEGATIVE_CONTROL: context.negativeControl ? "1" : "0",
      NODE_OPTIONS:
        nodeOptions.startsWith(`${preloadOption} `) || nodeOptions === preloadOption
          ? nodeOptions
          : `${preloadOption} ${nodeOptions}`.trim(),
    };
  };
  const guarded = (original, shell) =>
    function (...args) {
      if (!shell && args[1] == null) {
        args[1] = [];
      }
      const optionIndex = shell || !Array.isArray(args[1]) ? 1 : 2;
      let options =
        args[optionIndex] && typeof args[optionIndex] === "object" ? args[optionIndex] : {};
      let command = args[0] instanceof URL ? fileURLToPath(args[0]) : args[0];
      if (!shell && !options.shell) {
        let delegated;
        while (
          (delegated = unwrapTestEnvCommand(
            command,
            Array.isArray(args[1]) ? args[1] : [],
            options,
            blockGitHubTestCommand,
          ))
        ) {
          command = args[0] = delegated.command;
          args[1] = delegated.args;
          options = delegated.options;
        }
      }
      const env = options.env ?? process.env;
      const nextOptions = { ...options, env: childEnvironment(env, options.cwd) };
      let script;
      if (shell || options.shell) {
        const source = [args[0], ...(Array.isArray(args[1]) ? args[1] : [])].join(" ");
        const interpreter =
          typeof options.shell === "string"
            ? options.shell
            : process.platform === "win32"
              ? process.env.ComSpec || "cmd.exe"
              : "/bin/sh";
        const interpreterArgs =
          process.platform === "win32" && /(?:^|[\\/])cmd(?:\.exe)?$/iu.test(interpreter)
            ? ["/d", "/s", "/c", source]
            : ["-c", source];
        script = readTestShellSource(
          interpreter,
          interpreterArgs,
          nextOptions,
          resolveGitHubGuardExecutable,
          blockGitHubTestCommand,
        );
        if (!script) {
          blockGitHubTestCommand("unresolved-shell-input");
        }
        if (script.source !== source) {
          script = { ...script, source: `${script.source}\n${source}` };
        }
      } else {
        script = readTestShellSource(
          command,
          Array.isArray(args[1]) ? args[1] : [],
          nextOptions,
          resolveGitHubGuardExecutable,
          blockGitHubTestCommand,
        );
      }
      const shellCommand = script !== null;
      if (!shellCommand) {
        const checkedArgs = checkCommand(command, Array.isArray(args[1]) ? args[1] : [], options);
        if (Array.isArray(args[1])) {
          args[1] = checkedArgs;
        }
      } else {
        inspectTestShellSource(
          script,
          nextOptions,
          resolveGitHubGuardExecutable,
          (token, argv, scopedOptions, source, powershell) => {
            const name = (powershell ? path.win32.basename(token) : path.basename(token))
              .toLowerCase()
              .replace(/\.(?:exe|com|cmd|bat)$/u, "");
            if (
              (transportCommands.has(name) &&
                (path.isAbsolute(token) ||
                  process.platform === "win32" ||
                  /\.(?:exe|com|cmd|bat)$/iu.test(token) ||
                  token.includes("/") ||
                  name.startsWith("invoke-") ||
                  (powershell && ["curl", "wget"].includes(name)) ||
                  ["iwr", "irm"].includes(name))) ||
              token === envValue(scopedOptions.env ?? process.env, "OPENCLAW_GH_BIN")
            ) {
              checkCommand(token, argv, scopedOptions, source);
            }
          },
          blockGitHubTestCommand,
        );
      }
      if (typeof args[optionIndex] === "function") {
        args.splice(optionIndex, 0, nextOptions);
      } else {
        args[optionIndex] = nextOptions;
      }
      if (!shellCommand && transportCommands.has(path.basename(command).toLowerCase())) {
        args[0] = resolveGitHubGuardExecutable(command, env, options.cwd) ?? command;
        if (path.basename(command).toLowerCase() === "git" && !isTemporaryFixture(args[0])) {
          nextOptions.env.GIT_ALLOW_PROTOCOL = "file";
        }
      }
      return Reflect.apply(original, this, args);
    };
  for (const [name, original] of originals) {
    const shell = name === "exec" || name === "execSync";
    childProcess[name] = guarded(original, shell);
    const custom = Symbol.for("nodejs.util.promisify.custom");
    if (original[custom]) {
      childProcess[name][custom] = guarded(original[custom], shell);
    }
  }
  workerThreads.Worker = class Worker extends originalWorker {
    constructor(filename, options = {}) {
      super(filename, {
        ...options,
        env:
          options.env === workerThreads.SHARE_ENV
            ? options.env
            : childEnvironment(options.env ?? process.env),
        execArgv: [`--require=${preload}`, ...(options.execArgv ?? process.execArgv)],
      });
    }
  };
  const checkHttp = (args) => {
    for (const arg of args.slice(0, 2)) {
      if (typeof arg === "string" || arg instanceof URL) {
        const url = URL.parse(String(arg));
        if (url && isGitHubHost(url.hostname)) {
          blockGitHubTestCommand("http");
        }
      } else if (arg && typeof arg === "object") {
        const headers = Array.isArray(arg.headers)
          ? Array.isArray(arg.headers[0])
            ? arg.headers
            : Array.from({ length: Math.floor(arg.headers.length / 2) }, (_, index) => [
                arg.headers[index * 2],
                arg.headers[index * 2 + 1],
              ])
          : Object.entries(arg.headers ?? {});
        const hostHeaders = headers
          .filter(([name]) => typeof name === "string" && name.toLowerCase() === "host")
          .map(([, value]) => value);
        if (
          [arg.hostname, arg.host, arg.origin, ...hostHeaders]
            .flat(2)
            .some((value) => value && hasGitHubDestination(value, process.env))
        ) {
          blockGitHubTestCommand("http");
        }
        if (
          typeof arg.path === "string" &&
          ((typeof arg.method === "string" && arg.method.toUpperCase() === "CONNECT") ||
            /^https?:\/\//iu.test(arg.path)) &&
          hasGitHubDestination(arg.path, process.env)
        ) {
          blockGitHubTestCommand("http-proxy");
        }
      }
    }
  };
  const checkUndici = (options) => {
    const headers = options?.headers;
    let inspected = options;
    if (headers && !Array.isArray(headers) && typeof headers[Symbol.iterator] === "function") {
      // Materialize once: generators cannot be inspected and then consumed again by Undici.
      const pairs = Array.from(headers);
      if (pairs.some((pair) => !Array.isArray(pair) || pair.length !== 2)) {
        throw new TypeError("Undici headers must contain key-value pairs");
      }
      inspected = { ...options, headers: pairs.flat() };
    }
    checkHttp([inspected]);
    return inspected;
  };
  for (const { owner, descriptor } of originalUndiciDispatches) {
    Object.defineProperty(owner, "dispatch", {
      ...descriptor,
      value(options, handler) {
        let inspected;
        try {
          checkHttp([this[undiciOrigin]]);
          inspected = checkUndici(options);
        } catch (error) {
          // Preserve Undici's callback error contract for request/stream/pipeline callers.
          if (typeof handler?.onResponseError !== "function") {
            throw error;
          }
          handler.onResponseError(null, error);
          return false;
        }
        return Reflect.apply(descriptor.value, this, [inspected, handler]);
      },
    });
  }
  // Node also serializes eagerly for Expect and raw headers, bypassing _implicitHeader.
  // Guard the request's serialization owner, without patching ServerResponse.
  // eslint-disable-next-line no-underscore-dangle -- Cover both eager and deferred serialization at Node's existing owner.
  http.ClientRequest.prototype._storeHeader = function (firstLine, headers) {
    try {
      const requestLine = /^(\S+) (.*) HTTP\/\d\.\d\r\n$/u.exec(firstLine);
      checkHttp([{ method: requestLine?.[1], path: requestLine?.[2], headers }]);
    } catch (error) {
      this.destroy();
      throw error;
    }
    return Reflect.apply(originalStoreHeader, this, [firstLine, headers]);
  };
  for (const { module, request, get } of originalHttp) {
    for (const [name, original] of [
      ["request", request],
      ["get", get],
    ]) {
      module[name] = function (...args) {
        checkHttp(args);
        return Reflect.apply(original, this, args);
      };
    }
  }
  if (originalFetch) {
    if (OriginalRequest) {
      // Request owns a private dispatcher with no public accessor. Track its
      // construction and cloning so guarding fetch preserves the caller's routing.
      globalThis.Request = new Proxy(OriginalRequest, {
        construct(target, args, newTarget) {
          const [input, init] = args;
          let selected;
          const nextArgs =
            args.length === 0
              ? args
              : [
                  input,
                  mapRequestDispatcher(init, (value) => {
                    selected = value;
                    return value;
                  }),
                ];
          const request = Reflect.construct(target, nextArgs, newTarget);
          requestDispatchers.set(
            request,
            selected ||
              (input instanceof OriginalRequest
                ? requestDispatchers.has(input)
                  ? requestDispatchers.get(input)
                  : unknownDispatcher
                : null),
          );
          return request;
        },
      });
      OriginalRequest.prototype.clone = function () {
        const clone = Reflect.apply(originalRequestClone, this, []);
        requestDispatchers.set(
          clone,
          requestDispatchers.has(this) ? requestDispatchers.get(this) : unknownDispatcher,
        );
        return clone;
      };
    }
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (isGitHubHost(url.hostname)) {
        blockGitHubTestCommand("fetch");
      }
      // Native fetch reuses this dispatcher for every redirect. Inspect before
      // a proxy can replace the destination with its own socket address.
      return originalFetch(
        input,
        mapRequestDispatcher(init, (value) => {
          const selected =
            value ||
            (input instanceof OriginalRequest
              ? requestDispatchers.has(input)
                ? requestDispatchers.get(input)
                : unknownDispatcher
              : null);
          if (selected === unknownDispatcher) {
            blockGitHubTestCommand("unresolved-fetch-dispatcher");
          }
          const dispatcher = selected || getGlobalDispatcher();
          const dispatch = (options, handler) => {
            const inspected = checkUndici(options);
            // Undici 8's global owner supplies a v1 bridge for older native fetch.
            // Preserve that public adapter when injecting the default dispatcher.
            const delegate =
              !selected && typeof handler.onRequestStart !== "function"
                ? new Dispatcher1Wrapper(dispatcher)
                : dispatcher;
            return delegate.dispatch(inspected, handler);
          };
          return new Proxy(dispatcher, {
            get(target, key) {
              if (key === "dispatch") {
                return dispatch;
              }
              const member = Reflect.get(target, key, target);
              return typeof member === "function" ? member.bind(target) : member;
            },
          });
        }),
      );
    };
  }
  net.Socket.prototype.connect = function (...args) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const host = first && typeof first === "object" ? (first.host ?? first.hostname) : args[1];
    if (isGitHubHost(host)) {
      blockGitHubTestCommand("socket");
    }
    return Reflect.apply(originalConnect, this, args);
  };
  tls.connect = function (...args) {
    const options = args.find((arg) => arg && typeof arg === "object");
    if (isGitHubHost(options?.servername) || isGitHubHost(options?.host)) {
      blockGitHubTestCommand("tls");
    }
    return Reflect.apply(originalTlsConnect, this, args);
  };
  syncBuiltinESMExports();
  const restore = () => {
    for (const [name, original] of originals) {
      childProcess[name] = original;
    }
    globalThis.fetch = originalFetch;
    globalThis.Request = OriginalRequest;
    if (OriginalRequest) {
      OriginalRequest.prototype.clone = originalRequestClone;
    }
    net.Socket.prototype.connect = originalConnect;
    tls.connect = originalTlsConnect;
    workerThreads.Worker = originalWorker;
    for (const { owner, descriptor } of originalUndiciDispatches) {
      Object.defineProperty(owner, "dispatch", descriptor);
    }
    if (originalStoreHeaderDescriptor) {
      Object.defineProperty(
        http.ClientRequest.prototype,
        "_storeHeader",
        originalStoreHeaderDescriptor,
      );
    } else {
      // eslint-disable-next-line no-underscore-dangle -- Restore the inherited Node method by removing our own override.
      delete http.ClientRequest.prototype._storeHeader;
    }
    for (const { module, request, get } of originalHttp) {
      Object.assign(module, { request, get });
    }
    syncBuiltinESMExports();
    delete globalThis[guardKey];
  };
  globalThis[guardKey] = restore;
  return restore;
}

if (process.env[marker] === "1") {
  installGitHubNetworkGuard();
}
