import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Resolve env's command delegation before it can discard the child's preload. */
export function unwrapTestEnvCommand(command, args, options, block) {
  if (
    path
      .basename(command)
      .replace(/\.exe$/iu, "")
      .toLowerCase() !== "env"
  ) {
    return null;
  }
  let env = { ...(options.env ?? process.env) };
  let cwd = options.cwd;
  let index = 0;
  for (; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") {
      index++;
      break;
    }
    if (arg === "-0" || arg === "--null") {
      continue;
    }
    if (arg === "-i" || arg === "--ignore-environment" || arg === "-") {
      env = {};
    } else if (arg === "-u" || arg === "--unset") {
      delete env[args[++index]];
    } else if (arg.startsWith("--unset=")) {
      delete env[arg.slice(8)];
    } else if (arg === "-C" || arg === "--chdir") {
      cwd = args[++index];
    } else if (arg.startsWith("--chdir=")) {
      cwd = arg.slice(8);
    } else if (/^[A-Za-z_][A-Za-z_\d]*=/u.test(arg)) {
      const split = arg.indexOf("=");
      env[arg.slice(0, split)] = arg.slice(split + 1);
    } else if (arg.startsWith("-")) {
      block("unresolved-env-command");
    } else {
      break;
    }
  }
  if (index === args.length) {
    return null;
  }
  return { command: args[index], args: args.slice(index + 1), options: { ...options, cwd, env } };
}

/** Null means native code; a shell record also owns its built-in command policy. */
export function readTestShellSource(command, args, options, resolveExecutable, block) {
  const name = path
    .basename(command)
    .toLowerCase()
    .replace(/\.(?:exe|cmd|bat)$/u, "")
    .replace(/^-/u, "");
  const shells = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
  const powershell = ["powershell", "pwsh"].includes(name);
  if (shells.has(name) && String(options.argv0 ?? command).startsWith("-")) {
    block("unresolved-shell-startup");
  }
  if (name === "cmd") {
    const index = args.findIndex((arg) => /^\/[ck]$/iu.test(arg));
    if (index < 0 || !args.slice(0, index).some((arg) => /^\/d$/iu.test(arg))) {
      block("unresolved-shell-startup");
    }
    return { source: args.slice(index + 1).join(" "), powershell: false, cmd: true };
  }
  let file;
  if (powershell) {
    let noProfile = false;
    for (let index = 0; index < args.length; index++) {
      const arg = args[index].toLowerCase();
      if (["-noprofile", "-nop"].includes(arg)) {
        noProfile = true;
        continue;
      }
      if (["-command", "-c"].includes(arg)) {
        if (!noProfile) {
          block("unresolved-shell-startup");
        }
        if (args[index + 1] === "-") {
          break;
        }
        return { source: args.slice(index + 1).join(" "), powershell };
      }
      if (["-file", "-f"].includes(arg)) {
        file = args[index + 1];
        break;
      }
      if (["-help", "-?"].includes(arg) || (name === "pwsh" && ["-version", "-v"].includes(arg))) {
        return { source: "", powershell };
      }
      if (["-noninteractive", "-nologo", "-sta", "-mta"].includes(arg)) {
        continue;
      }
      if (
        [
          "-executionpolicy",
          "-inputformat",
          "-outputformat",
          "-workingdirectory",
          "-version",
          "-v",
        ].includes(arg)
      ) {
        index++;
      } else if (arg.startsWith("-")) {
        block("unresolved-powershell-input");
      } else {
        file = args[index];
        break;
      }
    }
    if (!noProfile) {
      block("unresolved-shell-startup");
    }
  } else if (shells.has(name)) {
    for (let index = 0; index < args.length; index++) {
      if (
        ["--rcfile", "--init-file", "--login", "--interactive"].includes(
          args[index].split("=", 1)[0],
        ) ||
        /^-[^-]*[il]/u.test(args[index]) ||
        (args[index] === "-o" && ["login", "interactive"].includes(args[index + 1]))
      ) {
        block("unresolved-shell-startup");
      }
      if (/^-[^-]*c/u.test(args[index])) {
        return { source: args[index + 1] ?? "", powershell };
      }
      if (["--version", "--help"].includes(args[index])) {
        return { source: "", powershell };
      }
      if (args[index] === "--") {
        file = args[index + 1];
        break;
      }
      if (["-o", "+o", "-O", "+O"].includes(args[index])) {
        index++;
      } else if (!args[index].startsWith("-") && !args[index].startsWith("+")) {
        file = args[index];
        break;
      }
    }
  }
  if (powershell || shells.has(name)) {
    if (!file || file === "-") {
      if (typeof options.input === "string" || Buffer.isBuffer(options.input)) {
        return { source: String(options.input), powershell };
      }
      block("unresolved-shell-input");
    }
    const cwd =
      options.cwd instanceof URL ? fileURLToPath(options.cwd) : (options.cwd ?? process.cwd());
    file = path.resolve(cwd, file);
  } else {
    file = resolveExecutable(command, options.env ?? process.env, options.cwd);
  }
  if (!file || !existsSync(file) || !statSync(file).isFile()) {
    return null;
  }
  const batch = /\.(?:cmd|bat)$/iu.test(file);
  // Native binaries and Node/Python fixtures do not have shell command syntax.
  if (!powershell && !shells.has(name) && !batch) {
    const descriptor = openSync(file, "r");
    const header = Buffer.alloc(256);
    try {
      const length = readSync(descriptor, header, 0, header.length, 0);
      const text = header.subarray(0, length).toString();
      if (!text.startsWith("#!")) {
        return null;
      }
      if (length === header.length && !/[\r\n]/u.test(text)) {
        block("unresolved-shell-shebang");
      }
      const declaration = text
        .slice(2)
        .split(/[\r\n]/u, 1)[0]
        .trim();
      // Admit literal interpreter arguments; env -S quoting/expansion needs an explicit fixture.
      if (/["'`$\\]/u.test(declaration)) {
        block("unresolved-shell-shebang");
      }
      const words = declaration.split(/\s+/u);
      let interpreter = words.shift();
      if (path.basename(interpreter) === "env") {
        if (words[0] === "-S" || words[0] === "--split-string") {
          words.shift();
        }
        interpreter = words.shift();
        if (!interpreter || /^[-\w]*=/u.test(interpreter) || interpreter.startsWith("-")) {
          block("unresolved-shell-shebang");
        }
      }
      const interpreterName = path.basename(interpreter).toLowerCase();
      if (!shells.has(interpreterName) && !["pwsh", "powershell"].includes(interpreterName)) {
        return null;
      }
      return readTestShellSource(
        interpreter,
        [...words, file],
        { ...options, argv0: interpreter },
        resolveExecutable,
        block,
      );
    } finally {
      closeSync(descriptor);
    }
  }
  if (statSync(file).size > 1024 * 1024) {
    block("unresolved-shell-source-size");
  }
  const source = readFileSync(file, "utf8");
  if (source.includes("\0")) {
    block("unresolved-shell-encoding");
  }
  return { source, powershell, cmd: batch };
}

/** Inspect literal delegation without executing or rewriting the shell program. */
export function inspectTestShellSource(script, options, resolveExecutable, checkCommand, block) {
  const active = new Set();
  let sourceBytes = 0;
  const visit = (current, depth, scopedOptions = options) => {
    const key = `${current.powershell}:${current.cmd ?? false}:${current.source}`;
    if (active.has(key)) {
      block("unresolved-shell-delegation");
    }
    active.add(key);
    sourceBytes += Buffer.byteLength(current.source);
    if (depth > 16 || sourceBytes > 1024 * 1024) {
      block("unresolved-shell-delegation");
    }
    const source = current.source.replace(/^\s*#[^\r\n]*/gmu, "");
    // Appending to PATH preserves shim precedence. Other shell-side lookup changes
    // need a fixture with an explicit child environment so the launcher can guard it.
    const assignments = source.matchAll(
      /(?:^|[\s;|&"'])(?:\$env:)?PATH(?:\[[^\]]+\])?\s*\+?=("(?:\\.|[^"\\])*"|'[^']*'|[^\s;|&]*)/giu,
    );
    for (const assignment of assignments) {
      if (
        current.powershell ||
        !/^(?:"\$(?:PATH|\{PATH\})(?::[^"$`]*|)"|\$(?:PATH|\{PATH\})(?::[^\s$`]*|))$/u.test(
          assignment[1],
        )
      ) {
        block("unresolved-shell-path");
      }
    }
    const protectedEnv =
      "(?:NODE_OPTIONS|GIT_ALLOW_PROTOCOL|OPENCLAW_TEST_GITHUB_[A-Z_]+|BASH_ENV|ENV|ZDOTDIR|BASH_FUNC_[^\\s=]+)";
    if (
      new RegExp(`(?:^|[\\s;|&"'])(?:\\$env:)?${protectedEnv}\\s*\\+?=`, "iu").test(source) ||
      new RegExp(
        `\\benv\\b[^;|&\\r\\n]*(?:--ignore-environment|\\s-i(?:\\s|$)|(?:-u\\s+|--unset(?:=|\\s+))(?:PATH|${protectedEnv}))`,
        "iu",
      ).test(source) ||
      /\b(?:command\s+-p|exec\s+-c)\b/u.test(source) ||
      /\b(?:env\s+(?:--ignore-environment|-i)\b|env\s+(?:-u\s+PATH|--unset(?:=|\s+)PATH)|printf\s+-v\s+PATH|read\s+PATH)\b/iu.test(
        source,
      )
    ) {
      block("unresolved-shell-environment");
    }
    const env = scopedOptions.env ?? process.env;
    const lookup = (variable) =>
      env[variable] ??
      (process.platform === "win32"
        ? env[Object.keys(env).find((name) => name.toUpperCase() === variable.toUpperCase())]
        : undefined);
    const expanded = source.replace(
      /\$env:([A-Za-z_][A-Za-z0-9_]*)|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)|%([A-Za-z_][A-Za-z0-9_]*)%/giu,
      (original, powershell, braced, plain, cmd) =>
        lookup(powershell ?? braced ?? plain ?? cmd) ?? original,
    );
    const matches = [...expanded.matchAll(/(?:\\.|"[^"]*"|'[^']*'|[^\s;&|()"'\\])+/gu)];
    const tokens = matches.map((match) =>
      match[0].replace(/\\(.)|"([^"]*)"|'([^']*)'/gu, (fragment, escaped, double, single) =>
        escaped === undefined
          ? (double ?? single)
          : process.platform === "win32" || current.cmd || current.powershell
            ? fragment
            : escaped,
      ),
    );
    const initialCwd =
      scopedOptions.cwd instanceof URL
        ? fileURLToPath(scopedOptions.cwd)
        : (scopedOptions.cwd ?? process.cwd());
    // Retain both sides of directory changes: branches, subshells and sourced
    // files may leave the caller in either directory. Never guess one branch won.
    const directories = new Set([initialCwd]);
    const addDirectory = (directory) => {
      directories.add(directory);
      if (existsSync(directory)) {
        directories.add(realpathSync(directory));
      }
      if (directories.size > 16) {
        block("unresolved-shell-cwd");
      }
    };
    let commandEnv = env;
    let assignmentPrefix = false;
    for (const [index, token] of tokens.entries()) {
      const previous = matches[index - 1];
      const separated =
        index === 0 ||
        /[;|&()\r\n]/u.test(
          expanded.slice(previous.index + previous[0].length, matches[index].index),
        );
      if (separated || ["then", "do", "if"].includes(tokens[index - 1])) {
        commandEnv = env;
        assignmentPrefix = false;
      }
      const boundary =
        separated ||
        assignmentPrefix ||
        ["exec", "command", "builtin", "then", "do", "if"].includes(tokens[index - 1]);
      const assignment = boundary && /^([A-Za-z_][A-Za-z_\d]*)=(.*)$/u.exec(token);
      if (assignment) {
        commandEnv = { ...commandEnv, [assignment[1]]: assignment[2] };
        assignmentPrefix = true;
        continue;
      }
      assignmentPrefix = false;
      const candidates = [];
      for (const cwd of directories) {
        candidates.push({ ...scopedOptions, cwd, env: commandEnv });
      }
      for (const candidate of candidates) {
        checkCommand(token, tokens.slice(index + 1), candidate, expanded, current.powershell);
      }
      if (!boundary || /[$`]/u.test(token)) {
        continue;
      }
      let end = index + 1;
      while (
        end < tokens.length &&
        !/[;|&()\r\n]/u.test(
          expanded.slice(matches[end - 1].index + matches[end - 1][0].length, matches[end].index),
        )
      ) {
        end++;
      }
      const argv = tokens.slice(index + 1, end);
      if (
        ["exec", "command", "builtin"].includes(token) &&
        argv[0]?.startsWith("-") &&
        !(token === "command" && ["-v", "-V"].includes(argv[0]))
      ) {
        // Wrapper options can replace argv0 or hide the delegated command boundary.
        block("unresolved-shell-delegation");
      }
      if (
        token === "unset" &&
        argv.some((arg) => new RegExp(`^(?:PATH|${protectedEnv})$`, "iu").test(arg))
      ) {
        block("unresolved-shell-environment");
      }
      const commandToken = current.cmd ? token.replace(/^@+/u, "") : token;
      const name = (
        current.cmd || current.powershell
          ? path.win32.basename(commandToken)
          : path.basename(commandToken)
      )
        .toLowerCase()
        .replace(/\.(?:exe|com|cmd|bat)$/u, "");
      if (
        (current.cmd && ["start", "call"].includes(name)) ||
        (current.powershell && ["start", "start-process", "saps"].includes(name))
      ) {
        block("unresolved-shell-delegation");
      }
      if (["pushd", "popd", "set-location"].includes(name)) {
        block("unresolved-shell-cwd");
      }
      if (name === "cd") {
        const args = argv[0] === "--" ? argv.slice(1) : argv;
        const target = args.length ? args[0] : commandEnv.HOME;
        if (
          args.length > 1 ||
          !target ||
          /^[-~]/u.test(target) ||
          /[$`]/u.test(target) ||
          (commandEnv.CDPATH && !path.isAbsolute(target))
        ) {
          block("unresolved-shell-cwd");
        }
        for (const candidate of candidates) {
          addDirectory(path.resolve(candidate.cwd, target));
        }
        continue;
      }
      for (const candidate of candidates) {
        if (name === "env") {
          const delegated = unwrapTestEnvCommand(token, argv, candidate, block);
          if (delegated) {
            const child = readTestShellSource(
              delegated.command,
              delegated.args,
              delegated.options,
              resolveExecutable,
              block,
            );
            if (child) {
              for (const directory of visit(child, depth + 1, delegated.options)) {
                addDirectory(directory);
              }
            }
          }
        } else if (
          ["source", "."].includes(token) &&
          tokens[index + 1] &&
          !/[$`]/u.test(tokens[index + 1])
        ) {
          const file =
            resolveExecutable(tokens[index + 1], commandEnv, candidate.cwd) ?? tokens[index + 1];
          const child = readTestShellSource("sh", [file], candidate, resolveExecutable, block);
          if (child) {
            for (const directory of visit(child, depth + 1, candidate)) {
              addDirectory(directory);
            }
          }
        } else {
          const child = readTestShellSource(token, argv, candidate, resolveExecutable, block);
          if (child) {
            for (const directory of visit(child, depth + 1, candidate)) {
              addDirectory(directory);
            }
          }
        }
      }
    }
    active.delete(key);
    return directories;
  };
  visit(script, 0);
}

/** Native curl cannot inherit Node hooks; constrain its own transfer policy. */
export function guardNativeHttpArgs(name, args, block, embedded = false) {
  if (!["curl", "wget", "invoke-webrequest", "invoke-restmethod", "iwr", "irm"].includes(name)) {
    return args;
  }
  if (args.length === 1 && ["--version", "-V", "--help", "-h"].includes(args[0])) {
    return args;
  }
  if (embedded || name !== "curl") {
    block("unresolved-native-http");
  }
  const switches = new Set([
    "--silent",
    "--show-error",
    "--fail",
    "--fail-with-body",
    "--head",
    "--insecure",
    "--compressed",
    "--globoff",
    "--disable",
    "--no-progress-meter",
  ]);
  const values = new Set([
    "--url",
    "--output",
    "--max-time",
    "--connect-timeout",
    "--request",
    "--header",
    "--user-agent",
    "--write-out",
  ]);
  const shortValues = new Set(["o", "m", "X", "H", "A", "w"]);
  const literalUrl = (value) => {
    // libcurl and WHATWG disagree on ambiguous authorities, including backslashes.
    // Admit only numeric loopback authorities without asking another URL parser.
    if (
      typeof value !== "string" ||
      // eslint-disable-next-line no-control-regex -- Reject controls that native URL parsers interpret differently.
      /[\\\u0000-\u0020\u007f]/u.test(value) ||
      !/^https?:\/\/(?:127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?(?:[/?#]|$)/u.test(value)
    ) {
      block("unresolved-native-http");
    }
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") {
      args.slice(index + 1).forEach(literalUrl);
      break;
    }
    if (arg.startsWith("--")) {
      const option = arg.split("=", 1)[0];
      if (values.has(option)) {
        const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[++index];
        if (option === "--url") {
          literalUrl(value);
        }
        if (option === "--header" && value?.startsWith("@")) {
          block("unresolved-native-http");
        }
      } else if (!switches.has(arg)) {
        block("unresolved-native-http");
      }
    } else if (arg.startsWith("-") && arg !== "-") {
      for (let offset = 1; offset < arg.length; offset++) {
        if (shortValues.has(arg[offset])) {
          const value = offset === arg.length - 1 ? args[++index] : arg.slice(offset + 1);
          if (arg[offset] === "H" && value?.startsWith("@")) {
            block("unresolved-native-http");
          }
          break;
        }
        if (!"sSfIkvq".includes(arg[offset])) {
          block("unresolved-native-http");
        }
      }
    } else {
      literalUrl(arg);
    }
  }
  // A loopback transfer must not inherit configuration, globbing or an external proxy.
  return ["-q", "--globoff", "--proxy", "", "--noproxy", "*", ...args];
}
