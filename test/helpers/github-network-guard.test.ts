import { execFileSync, execSync, fork, spawnSync } from "node:child_process";
import dns from "node:dns";
import { once } from "node:events";
import { chmodSync, copyFileSync, existsSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { get } from "node:https";
import { Socket } from "node:net";
import { join } from "node:path";
import tls from "node:tls";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import {
  Client,
  Dispatcher1Wrapper,
  getGlobalDispatcher,
  Pool,
  ProxyAgent,
  request as undiciRequest,
  setGlobalDispatcher,
} from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureFullEnv, withEnv } from "../../src/test-utils/env.js";
import { installSharedTestSetup } from "../setup.shared.js";
import {
  githubNetworkAttemptCounts,
  withGitHubNegativeControl as negativeControl,
} from "./github-network-guard.mjs";
import { requireNodeTool } from "./node-toolchain.js";
import { useAutoCleanupTempDirTracker } from "./temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const node = requireNodeTool("node");
const forbidden = "GitHub network access is forbidden in ordinary tests";

describe("ordinary tests cannot reach GitHub", () => {
  it.each(["explicit", "global", "Request clone", "undici request", "Client", "Pool"])(
    "blocks HTTP targets through a %s proxy dispatcher",
    async (mode) => {
      const requests: string[] = [];
      const received: { method: string | undefined; body: string }[] = [];
      // The proxy only returns synthetic responses; it never forwards a request.
      const proxy = createServer((req, response) => {
        let body = "";
        req.setEncoding("utf8");
        req.on("data", (chunk: string) => {
          body += chunk;
        });
        req.on("end", () => {
          received.push({ method: req.method, body });
          if (new URL(req.url ?? "/", `http://${req.headers.host}`).pathname === "/start") {
            response.writeHead(302, { location: "http://api.github.com/negative-control" });
          } else {
            response.writeHead(502);
          }
          response.end();
        });
      });
      proxy.on("connect", (req, socket) => {
        requests.push(req.url ?? "");
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        proxy.emit("connection", socket);
      });
      await new Promise<void>((resolve) => {
        proxy.listen(0, "127.0.0.1", resolve);
      });
      const address = proxy.address();
      if (!address || typeof address === "string") {
        throw new Error("proxy did not bind TCP");
      }
      const dispatcher = new ProxyAgent({
        uri: `http://127.0.0.1:${address.port}`,
        proxyTunnel: true,
      });
      const previous = getGlobalDispatcher();
      const before = githubNetworkAttemptCounts().negativeControl;
      let dispatcherReads = 0;
      try {
        if (mode === "Client" || mode === "Pool") {
          let connects = 0;
          const BoundDispatcher = mode === "Client" ? Client : Pool;
          const bound = new BoundDispatcher("http://api.github.com", {
            connect: (_options, callback) => {
              connects++;
              callback(new Error("unexpected proxy connector"), null);
            },
          });
          try {
            await expect(
              negativeControl(() => bound.request({ method: "GET", path: "/" })),
            ).rejects.toThrow(forbidden);
            expect(connects).toBe(0);
            expect(githubNetworkAttemptCounts().negativeControl).toBe(before + 1);
          } finally {
            await bound.close();
          }
          return;
        }
        if (mode === "undici request") {
          await expect(
            negativeControl(async () => {
              const response = await undiciRequest("http://api.github.com/negative-control", {
                dispatcher,
              });
              await response.body.dump();
            }),
          ).rejects.toThrow(forbidden);
          expect(githubNetworkAttemptCounts().negativeControl).toBe(before + 1);
          expect(requests).toEqual([]);
          expect(received).toEqual([]);
          return;
        }
        if (mode === "global") {
          setGlobalDispatcher(dispatcher);
        }
        const init = {
          redirect: "follow" as const,
          get dispatcher() {
            dispatcherReads++;
            return mode === "global" ? undefined : new Dispatcher1Wrapper(dispatcher);
          },
        };
        Object.setPrototypeOf(init, { method: "POST", body: "synthetic" });
        const input =
          mode === "Request clone"
            ? new Request(new Request("http://fixture.invalid/start", init).clone())
            : "http://fixture.invalid/start";
        await expect(
          negativeControl(() => fetch(input, mode === "Request clone" ? undefined : init)),
        ).rejects.toMatchObject({
          cause: { message: expect.stringContaining(forbidden) },
        });
        expect(githubNetworkAttemptCounts().negativeControl).toBe(before + 1);
        expect(requests).toEqual(["fixture.invalid:80"]);
        expect(received).toEqual([{ method: "POST", body: "synthetic" }]);
        expect(dispatcherReads).toBe(1);
      } finally {
        setGlobalDispatcher(previous);
        await dispatcher.close();
        await new Promise<void>((resolve, reject) => {
          proxy.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  );

  it.each(["path", "Host", "Host array"])(
    "checks late HTTP %s changes before headers are sent",
    async (destination) => {
      const proxy = createServer((_req, response) => {
        response.end();
      });
      await new Promise<void>((resolve) => {
        proxy.listen(0, "127.0.0.1", resolve);
      });
      const address = proxy.address();
      if (!address || typeof address === "string") {
        throw new Error("proxy did not bind TCP");
      }
      const req = request({
        hostname: "127.0.0.1",
        port: address.port,
        method: destination === "path" ? "CONNECT" : "GET",
        path: destination === "path" ? "fixture.invalid:443" : "/",
      });
      req.on("error", () => {});
      try {
        if (destination === "path") {
          req.path = "api.github.com:443";
        } else {
          req.setHeader(
            "hOsT",
            destination === "Host array" ? ["api.github.com", "fixture.invalid"] : "api.github.com",
          );
        }
        expect(() => negativeControl(() => req.end())).toThrow(forbidden);
      } finally {
        req.destroy();
        await new Promise<void>((resolve, reject) => {
          proxy.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  );

  it("blocks TLS SNI before dialing an IP address", () => {
    const before = githubNetworkAttemptCounts().negativeControl;
    expect(() =>
      negativeControl(() =>
        tls.connect({ host: "127.0.0.1", port: 443, servername: "api.github.com" }),
      ),
    ).toThrow(forbidden);
    expect(githubNetworkAttemptCounts().negativeControl).toBe(before + 1);
  });

  it.each([
    { method: "GET", path: "https://api.github.com/" },
    { method: "connect", path: "api.github.com:443" },
    { method: "GET", path: "HTTPS://api.github.com/" },
    { method: "GET", path: "/", headers: { hOsT: "api.github.com" } },
    { method: "GET", path: "/", headers: ["hOsT", "api.github.com"] },
  ])("blocks HTTP proxy requests before dispatch: $method", (options) => {
    const connect = vi.spyOn(Socket.prototype, "connect").mockImplementation(() => {
      throw new Error("unexpected proxy dispatch");
    });
    try {
      expect(() =>
        negativeControl(() => request({ hostname: "127.0.0.1", port: 1, ...options })),
      ).toThrow(forbidden);
      expect(connect).not.toHaveBeenCalled();
    } finally {
      connect.mockRestore();
    }
  });

  it.each(["Map", "Headers", "iterator"])(
    "checks Undici Host headers supplied as %s before dispatch",
    async (container) => {
      const headers = new Map([["host", "api.github.com"]]);
      const input =
        container === "Map"
          ? headers
          : container === "Headers"
            ? new Headers([...headers])
            : headers.entries();
      const connect = vi.spyOn(Socket.prototype, "connect").mockImplementation(() => {
        throw new Error("unexpected proxy dispatch");
      });
      try {
        await expect(
          negativeControl(() => undiciRequest("http://127.0.0.1:1/", { headers: input })),
        ).rejects.toThrow(forbidden);
        expect(connect).not.toHaveBeenCalled();
      } finally {
        connect.mockRestore();
      }
    },
  );

  it("preserves one-shot iterable headers for a permitted Undici request", async () => {
    const server = createServer((req, response) => {
      response.end(JSON.stringify({ host: req.headers.host, fixture: req.headers["x-fixture"] }));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("server did not bind TCP");
      }
      const client = new Client(`http://127.0.0.1:${address.port}`);
      try {
        const response = await client.request({
          method: "GET",
          path: "/",
          headers: new Map([
            ["host", "fixture.invalid"],
            ["x-fixture", "synthetic"],
          ]).entries(),
        });
        expect(await response.body.json()).toEqual({
          host: "fixture.invalid",
          fixture: "synthetic",
        });
      } finally {
        await client.close();
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("keeps the guard in workers with replaced environment and loader options", async () => {
    const worker = negativeControl(
      () =>
        new Worker(
          `const { parentPort } = require("node:worker_threads");
      require("node:dns").lookup = () => { throw new Error("unexpected DNS dispatch"); };
      fetch("https://api.github.com/").catch(error => parentPort.postMessage(error.message));`,
          { eval: true, env: {}, execArgv: [] },
        ),
    );
    try {
      const [message] = await once(worker, "message");
      expect(message).toContain(forbidden);
    } finally {
      await worker.terminate();
    }
  });

  it.each(["require", "import"])(
    "guards Node --%s startup modules before they execute",
    (option) => {
      const directory = tempDirs.make("github-node-preload-");
      const script = join(directory, "probe.cjs");
      writeFileSync(
        script,
        `require("node:net").Socket.prototype.connect = () => { throw new Error("unexpected socket dispatch"); };
try { require("node:http").request("http://api.github.com/negative-control"); }
catch (error) { console.log(error.message); }`,
      );
      const result = negativeControl(() =>
        spawnSync(node, ["-e", ""], {
          env: { NODE_OPTIONS: `--${option}=${JSON.stringify(script)}` },
          encoding: "utf8",
        }),
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(forbidden);
      expect(result.stdout).not.toContain("unexpected socket dispatch");
    },
  );

  it.skipIf(!existsSync("/bin/zsh"))("isolates Zsh startup files from the child's HOME", () => {
    const home = tempDirs.make("github-zsh-startup-");
    writeFileSync(join(home, ".zshenv"), "printf 'unexpected user startup\\n'\n");
    const result = spawnSync("/bin/zsh", ["-c", "printf 'guarded command\\n'"], {
      env: { HOME: home },
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("guarded command\n");
  });

  it.skipIf(process.platform === "win32")("blocks transport calls inside a shell script", () => {
    const directory = tempDirs.make("github-shell-script-guard-");
    const script = join(directory, "probe.sh");
    writeFileSync(script, "gh api repos/example/repo\n");
    const result = negativeControl(() => spawnSync("/bin/sh", [script], { encoding: "utf8" }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(forbidden);
  });

  it("strips GitHub credentials and startup hooks from children that replace their environment", () => {
    const result = spawnSync(
      node,
      [
        "-e",
        'console.log(JSON.stringify(Object.keys(process.env).filter(k => ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GH_CONFIG_DIR", "SSH_AUTH_SOCK", "BASH_ENV", "ENV", "BASH_FUNC_fixture%%"].includes(k))))',
      ],
      {
        env: {
          GH_TOKEN: "synthetic",
          GITHUB_TOKEN: "synthetic",
          GH_ENTERPRISE_TOKEN: "synthetic",
          GH_CONFIG_DIR: "/synthetic",
          SSH_AUTH_SOCK: "/synthetic",
          BASH_ENV: "/synthetic",
          ENV: "/synthetic",
          ZDOTDIR: "/synthetic",
          "BASH_FUNC_fixture%%": "() { printf synthetic; }",
        },
        encoding: "utf8",
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([]);
  });
  it.each([false, true])(
    "retains the real-home network barrier with profile loading %s",
    (loadProfileEnv) => {
      installSharedTestSetup().cleanup();
      const caller = captureFullEnv();
      const home = tempDirs.make("github-real-home-policy-");
      writeFileSync(join(home, ".profile"), "export LIVE=1\n");
      const lookup = vi.spyOn(dns, "lookup").mockImplementation(() => {
        throw new Error("unexpected DNS dispatch");
      });
      try {
        withEnv(
          {
            HOME: home,
            USERPROFILE: home,
            LIVE: undefined,
            OPENCLAW_LIVE_TEST: undefined,
            OPENCLAW_LIVE_GATEWAY: undefined,
            OPENCLAW_LIVE_USE_REAL_HOME: "1",
          },
          () => {
            const setup = installSharedTestSetup({ loadProfileEnv });
            try {
              expect(() => negativeControl(() => get("https://api.github.com/"))).toThrow(
                forbidden,
              );
              expect(lookup).not.toHaveBeenCalled();
            } finally {
              setup.cleanup();
            }
          },
        );
      } finally {
        lookup.mockRestore();
        caller.restore();
        installSharedTestSetup();
      }
    },
  );

  it.each(["api.github.com", "github.com", "tenant.ghe.com"])(
    "blocks HTTP and socket access to %s before dispatch",
    async (host) => {
      await expect(negativeControl(() => fetch(`https://${host}/`))).rejects.toThrow(forbidden);
      const socket = new Socket();
      try {
        expect(() => negativeControl(() => socket.connect({ host, port: 443 }))).toThrow(forbidden);
      } finally {
        socket.destroy();
      }
    },
  );

  it("blocks native HTTPS before DNS, including normalized Socket.connect arguments", () => {
    const lookup = vi.spyOn(dns, "lookup").mockImplementation(() => {
      throw new Error("unexpected DNS dispatch");
    });
    try {
      expect(() => negativeControl(() => get("https://api.github.com/"))).toThrow(forbidden);
      expect(lookup).not.toHaveBeenCalled();
    } finally {
      lookup.mockRestore();
    }
  });

  it.each(["api.github.com", "ghe.example.test"])(
    "keeps the guard for %s in a Node grandchild with a replaced environment",
    (host) => {
      vi.stubEnv("GH_HOST", "ghe.example.test");
      try {
        const probe = `import dns from "node:dns"; dns.lookup = () => { throw new Error("unexpected DNS dispatch"); }; await fetch("https://${host}/");`;
        const result = negativeControl(() =>
          spawnSync(
            node,
            [
              "--input-type=module",
              "-e",
              `
      import { spawnSync } from "node:child_process";
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(probe)}], { env: {}, encoding: "utf8" });
      process.stdout.write(child.stderr);
      process.exitCode = child.status === 1 ? 0 : 2;
    `,
            ],
            { env: {}, encoding: "utf8" },
          ),
        );
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain(forbidden);
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it("keeps the guard in forked Node modules selected by URL", async () => {
    const directory = tempDirs.make("github-fork-guard-");
    const script = join(directory, "probe.mjs");
    writeFileSync(
      script,
      'import dns from "node:dns"; dns.lookup = () => { throw new Error("unexpected DNS dispatch"); }; await fetch("https://api.github.com/");',
    );
    const child = negativeControl(() =>
      fork(pathToFileURL(script), [], {
        execPath: node,
        execArgv: [],
        env: {},
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      }),
    );
    let stderr = "";
    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const [code] = await once(child, "close");
    expect(code).toBe(1);
    expect(stderr).toContain(forbidden);
  });

  it.skipIf(process.platform === "win32").each(["tenant.ghe.com", "ghe.example.test"])(
    "blocks native HTTP to Enterprise host %s",
    (host) => {
      const directory = tempDirs.make("github-enterprise-http-guard-");
      symlinkSync("/usr/bin/true", join(directory, "curl"));
      const env = { PATH: directory, GH_HOST: "ghe.example.test" };
      expect(() =>
        negativeControl(() => execFileSync("curl", [`https://${host}/`], { env })),
      ).toThrow(forbidden);
      expect(() => negativeControl(() => execSync(`curl https://${host}/`, { env }))).toThrow(
        forbidden,
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "retains the parent's Enterprise host when native HTTP replaces its environment",
    () => {
      const directory = tempDirs.make("github-enterprise-parent-guard-");
      symlinkSync("/usr/bin/true", join(directory, "curl"));
      vi.stubEnv("GH_HOST", "ghe.example.test");
      try {
        expect(() =>
          negativeControl(() =>
            execFileSync("curl", ["https://ghe.example.test/"], { env: { PATH: directory } }),
          ),
        ).toThrow(forbidden);
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it.skipIf(process.platform !== "win32")("blocks cmd.exe environment URLs", () => {
    const directory = tempDirs.make("github-cmd-http-guard-");
    const curl = join(directory, "curl.cmd");
    writeFileSync(curl, "@exit /b 0\r\n");
    expect(() =>
      negativeControl(() =>
        execSync(`"${curl}" "%target_url%"`, {
          env: { Path: directory, TARGET_URL: "https://api.github.com/" },
        }),
      ),
    ).toThrow(forbidden);
    expect(() =>
      negativeControl(() =>
        execFileSync("powershell.exe", ["-Command", "Invoke-WebRequest $env:TARGET_URL"], {
          env: { Path: directory, TARGET_URL: "https://api.github.com/" },
        }),
      ),
    ).toThrow(forbidden);
  });

  it.skipIf(process.platform !== "win32")("preserves a Windows Path override", () => {
    const directory = tempDirs.make("github-windows-path-guard-");
    writeFileSync(join(directory, "fixture-command.cmd"), "@echo synthetic response\r\n");
    expect(execSync("fixture-command", { env: { Path: directory }, encoding: "utf8" }).trim()).toBe(
      "synthetic response",
    );
  });

  it.skipIf(process.platform !== "win32")("checks forward-slash relative native gh paths", () => {
    const directory = tempDirs.make("github-windows-relative-guard-");
    copyFileSync(node, join(directory, "gh.exe"));
    // This native alias only prints Node's version if admission is missing.
    expect(() =>
      negativeControl(() =>
        spawnSync("./gh.exe", ["--version"], { cwd: directory, env: { Path: "" } }),
      ),
    ).toThrow(forbidden);
  });

  it.skipIf(process.platform !== "win32")("checks the inherited Windows PATH with env={}", () => {
    const directory = tempDirs.make("github-windows-inherited-guard-");
    copyFileSync(node, join(directory, "gh.exe"));
    vi.stubEnv("PATH", directory);
    try {
      expect(() => negativeControl(() => spawnSync("gh", ["--version"], { env: {} }))).toThrow(
        forbidden,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.skipIf(process.platform === "win32")(
    "permits unrelated shell commands with an inherited native CLI override",
    () => {
      const env = { OPENCLAW_GH_BIN: node };
      expect(execSync("printf ok", { env, encoding: "utf8" })).toBe("ok");
      expect(() =>
        negativeControl(() => execSync('"$OPENCLAW_GH_BIN" --version', { env })),
      ).toThrow(forbidden);
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses a native gh executable and shell PATH fallback",
    () => {
      const directory = tempDirs.make("github-native-guard-");
      const gh = join(directory, "gh");
      symlinkSync(node, gh);
      expect(() => negativeControl(() => execFileSync(gh, ["--version"]))).toThrow(forbidden);
      for (const PATH of [directory, ""]) {
        const result = negativeControl(() =>
          spawnSync("/bin/sh", ["-c", "gh --version"], {
            env: { PATH },
            encoding: "utf8",
          }),
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(forbidden);
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "checks expanded and suffixed shell gh executables",
    () => {
      const directory = tempDirs.make("github-shell-executable-guard-");
      const gh = join(directory, "gh");
      symlinkSync(node, gh);
      symlinkSync(node, join(directory, "gh.exe"));
      // These native aliases only print Node's version if the guard is missing.
      expect(() =>
        negativeControl(() => execSync('"$GH_BIN" --version', { env: { GH_BIN: gh } })),
      ).toThrow(forbidden);
      expect(() =>
        negativeControl(() => execSync("gh.exe --version", { env: { PATH: directory } })),
      ).toThrow(forbidden);
      expect(() =>
        negativeControl(() =>
          execSync('"$GH_DIR"/"$GH_NAME" --version', {
            env: { GH_DIR: directory, GH_NAME: "gh" },
          }),
        ),
      ).toThrow(forbidden);
    },
  );

  it.skipIf(process.platform === "win32")(
    "blocks shell HTTP calls before dispatch, including environment URLs",
    () => {
      const directory = tempDirs.make("github-shell-http-guard-");
      // The pre-fix probe is harmless: this native alias only exits successfully.
      symlinkSync("/usr/bin/true", join(directory, "curl"));
      const env = { PATH: directory, TARGET_URL: "https://api.github.com/" };
      expect(() => negativeControl(() => execSync('curl "$TARGET_URL"', { env }))).toThrow(
        forbidden,
      );
      expect(() =>
        negativeControl(() =>
          execFileSync("/bin/sh", ["-c", "curl https://api.github.com/"], { env }),
        ),
      ).toThrow(forbidden);
      const result = negativeControl(() =>
        spawnSync("curl https://api.github.com/", [], {
          env,
          shell: true,
          encoding: "utf8",
        }),
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(forbidden);
    },
  );

  it.skipIf(process.platform === "win32")("blocks schemeless native HTTP URLs", () => {
    const directory = tempDirs.make("github-schemeless-http-guard-");
    symlinkSync("/usr/bin/true", join(directory, "curl"));
    const env = { PATH: directory };
    const destination = "api.github.com/repos/example/repo";
    expect(() => negativeControl(() => execFileSync("curl", [destination], { env }))).toThrow(
      forbidden,
    );
    expect(() =>
      negativeControl(() => execFileSync("curl", [`--url=${destination}`], { env })),
    ).toThrow(forbidden);
    expect(() => negativeControl(() => execSync(`curl ${destination}`, { env }))).toThrow(
      forbidden,
    );
  });

  it("preserves third-position subprocess options when arguments are omitted", () => {
    const directory = tempDirs.make("github-subprocess-options-");
    const script = join(directory, "probe.mjs");
    writeFileSync(
      script,
      "console.log(JSON.stringify({ cwd: process.cwd(), value: process.env.FIXTURE_VALUE }));",
    );
    const options = {
      cwd: pathToFileURL(directory),
      env: {
        FIXTURE_VALUE: "synthetic value",
        NODE_OPTIONS: `--import=${JSON.stringify(pathToFileURL(script).href)}`,
      },
      encoding: "utf8" as const,
    };
    const expected = { cwd: directory, value: "synthetic value" };
    const child = spawnSync(node, undefined, options);
    expect(child.status, child.stderr.toString()).toBe(0);
    expect(typeof child.stdout).toBe("string");
    expect(JSON.parse(child.stdout.toString())).toEqual(expected);
    const output = execFileSync(node, undefined, options);
    expect(typeof output).toBe("string");
    expect(JSON.parse(output.toString())).toEqual(expected);
  });

  it.skipIf(process.platform === "win32")(
    "retains a captured Git shim through fixture wrappers and a clean native environment",
    () => {
      const directory = tempDirs.make("github-captured-git-");
      const captured = execFileSync("/bin/sh", ["-c", "command -v git"], {
        encoding: "utf8",
      }).trim();
      const fixture = join(directory, "git");
      writeFileSync(fixture, `#!/bin/sh\nexec '${captured.replaceAll("'", "'\\''")}' "$@"\n`, {
        mode: 0o755,
      });
      const result = spawnSync(
        "/usr/bin/env",
        ["-i", `PATH=${directory}:/usr/bin:/bin`, fixture, "--version"],
        { encoding: "utf8", timeout: 5000 },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toMatch(/^git version /u);
    },
  );

  it.skipIf(process.platform === "win32")(
    "preserves system command lookup when PATH is omitted",
    () => {
      const result = spawnSync("true", [], { env: {} });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
    },
  );

  it.skipIf(process.platform === "win32")(
    "runs the temporary gh fixture instead of a real CLI",
    () => {
      const directory = tempDirs.make("github-fixture-guard-");
      const gh = join(directory, "gh");
      writeFileSync(gh, `#!${node}\nprocess.stdout.write('synthetic response');\n`);
      chmodSync(gh, 0o755);
      expect(execFileSync(gh, ["api", "repos/example/repo"], { encoding: "utf8" })).toBe(
        "synthetic response",
      );
    },
  );

  it.skipIf(process.platform === "win32").each(["./gh", "gh"])(
    "resolves %s with URL-valued cwd and relative PATH",
    (command) => {
      const directory = tempDirs.make("github-cwd-url-guard-");
      const gh = join(directory, "gh");
      writeFileSync(gh, `#!${node}\nprocess.stdout.write('synthetic response');\n`);
      chmodSync(gh, 0o755);
      expect(
        execFileSync(command, ["api", "repos/example/repo"], {
          cwd: pathToFileURL(directory),
          env: { PATH: "." },
          encoding: "utf8",
        }),
      ).toBe("synthetic response");
    },
  );
});
