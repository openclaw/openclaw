import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Duplex } from "node:stream";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveRuntimeProcessEntrypointUrl } from "../../infra/runtime-process-url.js";
import { resolveRuntimeWorkerArgv } from "../../infra/runtime-worker-url.js";
import { killPidIfAlive } from "../../test-utils/process-tree.js";
import { readLines } from "./service-child-group-anchor.preparation.test-support.js";
import { isOwnedProcessGroupGone } from "./service-child-group-ownership.js";
import {
  readServiceChildMessage,
  type ServiceChildAnchorMessage,
  type ServiceChildControlPayload,
} from "./service-child-protocol.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.skipIf(process.platform === "win32")(
  "uses the admitted native anchor outside generic Bun mode and joins output and lineage",
  async () => {
    const root = tempDirs.make("relay-native-owner-");
    const marker = path.join(root, "native-anchor.json");
    const nativeOwner = path.join(root, "native-anchor.ts");
    const anchor = resolveRuntimeProcessEntrypointUrl("serviceChildGroupAnchor");
    await writeFile(
      nativeOwner,
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid, genericMode: process.env.BUN_BE_BUN ?? null, embeddedInventory: typeof globalThis.__openclawStandaloneIsEmbeddedModule }));
await import(${JSON.stringify(anchor.href)});`,
    );
    const relay = resolveRuntimeProcessEntrypointUrl("serviceChildRelay");
    const child = spawn(process.execPath, resolveRuntimeWorkerArgv(relay), {
      env: { ...process.env, BUN_BE_BUN: "1" },
      stdio: ["pipe", "pipe", "pipe", "pipe", "pipe", "ipc"],
    });
    const closed = once(child, "close");
    const control = child.stdio[3];
    const lineage = child.stdio[4];
    if (!(control instanceof Duplex) || !(lineage instanceof Duplex)) {
      child.kill("SIGKILL");
      throw new Error("Expected private control and lineage pipes");
    }
    const generation = "native-owner-regression";
    const messages: ServiceChildAnchorMessage[] = [];
    let sequence = 0;
    const send = (payload: ServiceChildControlPayload) =>
      control.write(JSON.stringify({ ...payload, generation, sequence: ++sequence }) + "\n");
    control.on("error", () => {});
    readLines(control, (line) => {
      const message = readServiceChildMessage(JSON.parse(line));
      if (!("sequence" in message)) {
        throw new Error("Expected native anchor control receipt");
      }
      messages.push(message);
      if (message.type === "closing") {
        send({ type: "closing-ack", closingSequence: message.sequence });
      }
    });
    lineage.once("end", () => {
      if (!control.destroyed) {
        send({ type: "lineage-closed" });
      }
    });
    lineage.resume();
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    try {
      child.send({
        type: "start",
        generation,
        command: process.execPath,
        args: [
          "-e",
          'process.stdout.write("native stdout tail"); process.stderr.write("native stderr tail")',
        ],
        stdinMode: "pipe-closed",
        controlFd: 3,
        lineageFd: 4,
        acknowledgeClosing: true,
        nativeProcessOwner: pathToFileURL(nativeOwner).href,
      });
      child.stdin!.end();
      expect(await closed).toEqual([0, null]);
      expect(stdout).toBe("native stdout tail");
      expect(stderr).toBe("native stderr tail");
      const receipt = JSON.parse(await readFile(marker, "utf8"));
      expect(receipt.genericMode).toBeNull();
      expect(receipt.embeddedInventory).toBe("undefined");
      const ready = messages.find((message) => message.type === "ready");
      expect(ready).toMatchObject({ anchorPid: receipt.pid });
      expect(messages).toContainEqual(
        expect.objectContaining({ type: "root-result", code: 0, signal: null }),
      );
      expect(messages).toContainEqual(expect.objectContaining({ type: "closing" }));
      expect(lineage.readableEnded).toBe(true);
      expect(isOwnedProcessGroupGone(receipt.pid)).toBe(true);
    } finally {
      killPidIfAlive(child.pid);
      for (const message of messages) {
        if (message.type === "ready") {
          killPidIfAlive(message.anchorPid);
        }
      }
      await closed;
    }
  },
);
