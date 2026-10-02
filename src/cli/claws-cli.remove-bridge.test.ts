import { spawn } from "node:child_process";
import { once } from "node:events";
import { Duplex } from "node:stream";
import { expect, it } from "vitest";
import {
  CLAW_REMOVE_AUTHORITY_DENIED,
  CLAW_REMOVE_AUTHORITY_GRANTED,
  CLAW_REMOVE_GATEWAY_BRIDGE_ENV,
} from "../claws/remove-gateway-bridge-protocol.js";

it("does not reuse a late fd3 grant after a failed authority exchange", async () => {
  const moduleUrl = new URL("./claws-cli.remove-bridge.ts", import.meta.url).href;
  const script = `
    const { createClawRemoveCliGatewayBridge } = await import(${JSON.stringify(moduleUrl)});
    const bridge = createClawRemoveCliGatewayBridge();
    let first = null;
    try { bridge.assertCurrent(); } catch (error) { first = error.message; }
    process.send({ phase: "first", error: first });
    process.once("message", () => {
      let second = null;
      try { bridge.assertCurrent(); } catch (error) { second = error.message; }
      process.send({ phase: "second", error: second }, () => {
        bridge.close();
        process.disconnect();
      });
    });
  `;
  const child = spawn(
    process.execPath,
    ["--import", "./scripts/tsx.mjs", "--input-type=module", "-e", script],
    {
      cwd: process.cwd(),
      env: { ...process.env, [CLAW_REMOVE_GATEWAY_BRIDGE_ENV]: "1" },
      stdio: ["ignore", "ignore", "pipe", "pipe", "ipc"],
    },
  );
  const control = child.stdio[3];
  expect(control).toBeInstanceOf(Duplex);
  if (!(control instanceof Duplex)) {
    child.kill();
    return;
  }
  let requests = 0;
  control.on("data", (chunk: Buffer) => {
    requests += chunk.length;
    if (requests === 1) {
      control.write(Buffer.from([CLAW_REMOVE_AUTHORITY_DENIED]));
    }
  });
  const deadline = AbortSignal.timeout(30_000);
  const exited = once(child, "exit", { signal: deadline });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  try {
    const [first] = await once(child, "message", { signal: deadline });
    expect(first).toMatchObject({ phase: "first", error: expect.any(String) });
    await new Promise<void>((resolve) => {
      control.write(Buffer.from([CLAW_REMOVE_AUTHORITY_GRANTED]), () => resolve());
    });
    const secondMessage = once(child, "message", { signal: deadline });
    child.send({ phase: "continue" });
    const [second] = await secondMessage;
    expect(second).toMatchObject({
      phase: "second",
      error: expect.stringContaining("no longer active"),
    });
    expect(requests).toBe(1);
    const [code] = await exited;
    expect(code).toBe(0);
  } catch (error) {
    throw new Error(`Child authority regression failed: ${String(error)}; stderr: ${stderr}`, {
      cause: error,
    });
  } finally {
    child.kill();
  }
}, 35_000);
