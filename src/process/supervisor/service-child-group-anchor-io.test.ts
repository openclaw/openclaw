import { once } from "node:events";
import { PassThrough } from "node:stream";
import { finished } from "node:stream/promises";
import { expect, it } from "vitest";
import { relayCommandOutput } from "./service-child-group-anchor-io.js";

it("flushes handed-off output while keeping the service writer open", async () => {
  const source = new PassThrough();
  const destination = new PassThrough();
  const output: Buffer[] = [];
  destination.on("data", (chunk: Buffer) => output.push(chunk));
  const release = relayCommandOutput(source, destination, () => undefined);
  source.write("before handoff");
  const drained = release();
  await finished(destination);
  expect(Buffer.concat(output).toString()).toBe("before handoff");
  expect(source.destroyed).toBe(false);
  source.write("service still running");
  source.end();
  await drained;
  expect(Buffer.concat(output).toString()).toBe("before handoff");
});

it("still closes the owned source when its output destination fails", async () => {
  const source = new PassThrough();
  const destination = new PassThrough();
  relayCommandOutput(source, destination, () => undefined);
  const closed = once(source, "close");
  destination.destroy(new Error("output lost"));
  await closed;
  expect(source.destroyed).toBe(true);
});
