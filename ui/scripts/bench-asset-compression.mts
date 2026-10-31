// Run from the repository root with node --import ./scripts/tsx.mjs.
import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { Agent, get } from "node:http";
import { cpus, loadavg } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { brotliCompress, constants, gzip as zlibGzip } from "node:zlib";
import { gzip } from "libdeflate";
import { selectControlUiRoutePreloads } from "../../src/gateway/control-ui-route-preloads.ts";
import { extractControlUiStartupAssetPaths } from "../config/control-ui-startup-assets.ts";

const { values } = parseArgs({
  options: {
    "bundle-dir": { type: "string", default: "dist/control-ui" },
    output: { type: "string", default: ".artifacts/asset-compression.json" },
    surface: { type: "string", default: "chat" },
    rounds: { type: "string", default: "5" },
    "http-requests": { type: "string", default: "0" },
    "brotli11-output": { type: "string" },
    "http-child": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});
const bundleDir = path.resolve(values["bundle-dir"]);
const compressBrotli = promisify(brotliCompress);
const compressGzip = promisify(zlibGzip);
const modes = ["brotli10", "brotli11", "libdeflate-gzip11", "zlib-gzip6", "brotli4"] as const;
type Mode = (typeof modes)[number];
type Sample = { wallMs: number; cpuUserMs: number; cpuSystemMs: number; cpuTotalMs: number };
type Reply = { id: number; value?: unknown; error?: string };

function integer(value: string, name: string, minimum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return parsed;
}

function measurement(start: bigint, cpu: NodeJS.CpuUsage): Sample {
  const elapsedCpu = process.cpuUsage(cpu);
  return {
    wallMs: Number(process.hrtime.bigint() - start) / 1e6,
    cpuUserMs: elapsedCpu.user / 1000,
    cpuSystemMs: elapsedCpu.system / 1000,
    cpuTotalMs: (elapsedCpu.user + elapsedCpu.system) / 1000,
  };
}

function summarize(samples: Sample[]) {
  return Object.fromEntries(
    (["wallMs", "cpuUserMs", "cpuSystemMs", "cpuTotalMs"] as const).map((key) => {
      const sorted = samples.map((sample) => sample[key]).toSorted((a, b) => a - b);
      const middle = Math.floor(sorted.length / 2);
      return [
        key,
        {
          median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1]! + sorted[middle]!) / 2,
          p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
          min: sorted[0],
          max: sorted.at(-1),
        },
      ];
    }),
  );
}

async function compress(body: Buffer, mode: Mode): Promise<Buffer> {
  if (mode === "libdeflate-gzip11") {
    return Buffer.from(gzip(body, 11));
  }
  if (mode === "zlib-gzip6") {
    return compressGzip(body, { level: 6 });
  }
  const quality = mode === "brotli11" ? 11 : mode === "brotli10" ? 10 : 4;
  return compressBrotli(body, { params: { [constants.BROTLI_PARAM_QUALITY]: quality } });
}

// Separate process: reported delivery CPU excludes the load-generating HTTP client.
async function serveChild() {
  const { startControlUiBenchGatewayServer } =
    await import("../../scripts/lib/control-ui-bench-gateway-server.ts");
  const server = await startControlUiBenchGatewayServer(bundleDir);
  let start: bigint | undefined;
  let cpu: NodeJS.CpuUsage | undefined;
  process.on("message", (message: { id: number; action: string }) => {
    void (async () => {
      if (message.action === "start") {
        start = process.hrtime.bigint();
        cpu = process.cpuUsage();
        return null;
      }
      if (message.action === "end") {
        if (start === undefined || cpu === undefined) {
          throw new Error("HTTP sample was not started");
        }
        return measurement(start, cpu);
      }
      if (message.action === "close") {
        await server.close();
        return null;
      }
      throw new Error(`Unknown child action: ${message.action}`);
    })().then(
      (value) => process.send?.({ id: message.id, value }),
      (error: unknown) =>
        process.send?.({
          id: message.id,
          error: error instanceof Error ? error.message : String(error),
        }),
    );
  });
  process.on("disconnect", () => {
    void server.close().finally(() => process.exit());
  });
  process.send?.({ id: 0, value: server.baseUrl });
}

function childRequest(child: ChildProcess, id: number, action: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", onError);
      clearTimeout(timer);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = () => onError(new Error("HTTP benchmark child exited before replying"));
    const onMessage = (reply: Reply) => {
      if (reply.id !== id) {
        return;
      }
      cleanup();
      if (reply.error) {
        reject(new Error(reply.error));
      } else {
        resolve(reply.value);
      }
    };
    const timer = setTimeout(() => onError(new Error("HTTP benchmark child timed out")), 60_000);
    child.on("message", onMessage);
    child.once("exit", onExit);
    child.once("error", onError);
    if (id > 0) {
      child.send({ id, action }, (error) => error && onError(error));
    }
  });
}

function requestAsset(baseUrl: string, file: string, encoding: string, agent: Agent) {
  return new Promise<{ bytes: number; encoding: string }>((resolve, reject) => {
    const request = get(
      new URL(file, `${baseUrl}/`),
      { agent, headers: { "Accept-Encoding": encoding } },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`${file}: HTTP ${response.statusCode}`));
          return;
        }
        let bytes = 0;
        response.on("data", (chunk: Buffer) => (bytes += chunk.length));
        response.on("error", reject);
        response.on("end", () => {
          const returnedEncoding = response.headers["content-encoding"];
          resolve({ bytes, encoding: returnedEncoding ?? "identity" });
        });
      },
    );
    request.setTimeout(30_000, () => request.destroy(new Error(`${file}: request timed out`)));
    request.on("error", reject);
  });
}

async function measureHttp(files: string[], rounds: number, count: number) {
  const child = fork(fileURLToPath(import.meta.url), ["--http-child", "--bundle-dir", bundleDir], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  let id = 0;
  try {
    const baseUrl = (await childRequest(child, id++, "ready")) as string;
    const results = Object.fromEntries(
      ["br", "gzip", "identity"].map((encoding) => [
        encoding,
        {
          samples: [] as Sample[],
          responseBytes: 0,
          representations: {} as Record<string, number>,
        },
      ]),
    );
    // Warm file-reader/cache and socket startup separately from measured serving.
    for (const encoding of Object.keys(results)) {
      for (const file of files) {
        await requestAsset(baseUrl, file, encoding, agent);
      }
    }
    for (let round = 0; round < rounds; round++) {
      const encodings = Object.keys(results);
      for (let position = 0; position < encodings.length; position++) {
        const encoding = encodings[(round + position) % encodings.length]!;
        const result = results[encoding]!;
        let responseBytes = 0;
        const representations: Record<string, number> = {};
        await childRequest(child, id++, "start");
        for (let index = 0; index < count; index++) {
          const response = await requestAsset(
            baseUrl,
            files[index % files.length]!,
            encoding,
            agent,
          );
          responseBytes += response.bytes;
          representations[response.encoding] = (representations[response.encoding] ?? 0) + 1;
        }
        result.samples.push((await childRequest(child, id++, "end")) as Sample);
        result.responseBytes = responseBytes;
        result.representations = representations;
      }
    }
    return Object.fromEntries(
      Object.entries(results).map(([encoding, result]) => [
        encoding,
        { ...result, requestsPerSample: count, summary: summarize(result.samples) },
      ]),
    );
  } finally {
    agent.destroy();
    if (child.connected) {
      await childRequest(child, id, "close").finally(() => child.disconnect());
    }
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
      });
    }
  }
}

async function main() {
  if (values.help) {
    console.log(`Usage: node --import ./scripts/tsx.mjs ui/scripts/bench-asset-compression.mts
  --bundle-dir dist/control-ui --surface chat --rounds 5
  --http-requests 300 --output .artifacts/asset-compression.json
  [--brotli11-output .artifacts/control-ui-brotli11]

Surfaces: startup, chat, new, all. "all" measures assets with build-produced sidecars.
Compression buffers are loaded before timing; modes rotate each round. Optional
HTTP samples warm each representation, then issue exactly N sequential requests
through the production Control UI handler in a separate server process. This
isolates serving CPU, but excludes full Gateway admission/auth and browser work.`);
    return;
  }
  const rounds = integer(values.rounds, "rounds", 1);
  const httpRequests = integer(values["http-requests"], "http-requests", 0);
  const html = await readFile(path.join(bundleDir, "index.html"), "utf8");
  const surface = values.surface;
  if (!["startup", "chat", "new", "all"].includes(surface)) {
    throw new Error("surface must be startup, chat, new, or all");
  }
  const files =
    surface === "all"
      ? [
          ...new Set(
            (await readdir(path.join(bundleDir, "assets")))
              .filter((file) => /\.(?:br|gz)$/u.test(file))
              .map((file) => `assets/${file.replace(/\.(?:br|gz)$/u, "")}`),
          ),
        ].toSorted()
      : extractControlUiStartupAssetPaths(
          selectControlUiRoutePreloads(
            html,
            surface === "chat" || surface === "new" ? surface : null,
          ),
        );
  if (!files.length) {
    throw new Error("Selected bundle surface has no assets");
  }
  const assets = await Promise.all(
    files.map(async (file) => ({ file, body: await readFile(path.join(bundleDir, file)) })),
  );
  const inventory = await Promise.all(
    assets.map(async ({ file, body }) => {
      const sidecar = async (extension: string) => {
        try {
          return {
            bytes: (await readFile(path.join(bundleDir, `${file}.${extension}`))).length,
            present: true,
          };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return { bytes: body.length, present: false };
          }
          throw error;
        }
      };
      const [br, gz] = await Promise.all([sidecar("br"), sidecar("gz")]);
      return {
        file,
        sha256: createHash("sha256").update(body).digest("hex"),
        identityBytes: body.length,
        shippedBrBytes: br.bytes,
        shippedGzipBytes: gz.bytes,
        hasBrSidecar: br.present,
        hasGzipSidecar: gz.present,
        compressedBytes: {} as Record<Mode, number>,
      };
    }),
  );
  const samples = Object.fromEntries(modes.map((mode) => [mode, [] as Sample[]])) as Record<
    Mode,
    Sample[]
  >;
  // Exclude first-use WASM/native setup from compression throughput.
  for (const mode of modes) {
    await compress(Buffer.from("compression benchmark warmup"), mode);
  }
  const hostLoadBefore = loadavg();
  const sampleOrder: Mode[] = [];
  const candidateBrotli = new Map<string, Buffer>();
  for (let round = 0; round < rounds; round++) {
    for (let position = 0; position < modes.length; position++) {
      const mode = modes[(round + position) % modes.length]!;
      sampleOrder.push(mode);
      const start = process.hrtime.bigint();
      const cpu = process.cpuUsage();
      const lengths: number[] = [];
      for (const { file, body } of assets) {
        const compressed = await compress(body, mode);
        lengths.push(compressed.length);
        if (values["brotli11-output"] && mode === "brotli11" && round === 0) {
          candidateBrotli.set(file, compressed);
        }
      }
      samples[mode].push(measurement(start, cpu));
      for (const [index, length] of lengths.entries()) {
        const previous = inventory[index]!.compressedBytes[mode];
        if (previous !== undefined && previous !== length) {
          throw new Error(`Non-deterministic compressed size: ${mode} ${files[index]}`);
        }
        inventory[index]!.compressedBytes[mode] = length;
      }
      console.log(`${mode} round ${round + 1}/${rounds}: ${lengths.reduce((a, b) => a + b, 0)} B`);
    }
  }
  const output = {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    bundleDir,
    surface,
    rounds,
    runtime: {
      node: process.version,
      zlib: process.versions.zlib,
      platform: process.platform,
      arch: process.arch,
    },
    host: {
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      loadBefore: hostLoadBefore,
      loadAfter: loadavg(),
    },
    assumptions: [
      "Compression CPU is process CPU, including native worker threads; inputs are already in memory.",
      "Compression runs serially and excludes disk writes, full Vite build work, and first-use codec setup.",
      "libdeflate gzip level 11 matches the current UI build; zlib level 6 and Brotli quality 4 model dynamic compression.",
      "Raw codec bytes are reported even when larger than identity; shipped totals use sidecar-or-identity selection.",
      "existingEligibilityBytes keeps current sidecar eligibility, so it does not credit compressing previously identity-only assets.",
      "HTTP CPU is isolated server-process CPU for the production Control UI handler, with warm reader/cache and one persistent HTTP/1 socket.",
      "HTTP does not exercise full Gateway admission/auth, network RTT, browser scheduling, or dynamic compression.",
    ],
    sampleOrder,
    assets: inventory,
    totals: {
      requests: inventory.length,
      identityBytes: inventory.reduce((sum, asset) => sum + asset.identityBytes, 0),
      shippedBrBytes: inventory.reduce((sum, asset) => sum + asset.shippedBrBytes, 0),
      shippedGzipBytes: inventory.reduce((sum, asset) => sum + asset.shippedGzipBytes, 0),
    },
    compression: Object.fromEntries(
      modes.map((mode) => [
        mode,
        {
          bytes: inventory.reduce((sum, asset) => sum + asset.compressedBytes[mode], 0),
          existingEligibilityBytes: inventory.reduce(
            (sum, asset) =>
              sum +
              ((mode.startsWith("brotli") ? asset.hasBrSidecar : asset.hasGzipSidecar)
                ? asset.compressedBytes[mode]
                : asset.identityBytes),
            0,
          ),
          samples: samples[mode],
          summary: summarize(samples[mode]),
        },
      ]),
    ),
    http: null as Awaited<ReturnType<typeof measureHttp>> | null,
    brotli11Bundle: null as { path: string; modifiedFiles: string[] } | null,
  };
  const outputPath = path.resolve(values.output);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  if (values["brotli11-output"]) {
    const target = path.resolve(values["brotli11-output"]);
    if (target === bundleDir || target.startsWith(`${bundleDir}${path.sep}`)) {
      throw new Error("brotli11-output must be outside the input bundle");
    }
    await mkdir(path.dirname(target), { recursive: true });
    try {
      await lstat(target);
      throw new Error(`brotli11-output already exists: ${target}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    await cp(bundleDir, target, { recursive: true, force: false, errorOnExist: true });
    const modifiedFiles: string[] = [];
    for (const asset of inventory) {
      if (asset.hasBrSidecar) {
        await writeFile(path.join(target, `${asset.file}.br`), candidateBrotli.get(asset.file)!);
        modifiedFiles.push(`${asset.file}.br`);
      }
    }
    output.brotli11Bundle = { path: target, modifiedFiles };
    await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  }
  if (httpRequests) {
    output.http = await measureHttp(files, rounds, httpRequests);
    await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  }
  console.log(`Wrote ${outputPath}`);
}

await (values["http-child"] ? serveChild() : main()).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
