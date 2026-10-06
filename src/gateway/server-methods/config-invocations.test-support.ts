import { expectDefined } from "@openclaw/normalization-core";
import { configHandlers } from "./config.js";
import { createConfigHandlerHarness } from "./config.test-helpers.js";

export async function invokeConfigPatch(args: {
  raw: unknown;
  baseHash?: string;
  replacePaths?: string[];
}) {
  const harness = createConfigHandlerHarness({
    method: "config.patch",
    params: {
      raw: JSON.stringify(args.raw),
      ...(args.baseHash ? { baseHash: args.baseHash } : {}),
      ...(args.replacePaths ? { replacePaths: args.replacePaths } : {}),
    },
  });
  await expectDefined(
    configHandlers["config.patch"],
    'configHandlers["config.patch"] test invariant',
  )(harness.options);
  return harness;
}

export function startConfigWrite(
  method: "config.patch" | "config.apply",
  args: { raw: unknown; baseHash?: string },
) {
  const harness = createConfigHandlerHarness({
    method,
    params: {
      raw: JSON.stringify(args.raw),
      ...(args.baseHash ? { baseHash: args.baseHash } : {}),
    },
  });
  const handler = expectDefined(
    configHandlers[method],
    `configHandlers["${method}"] test invariant`,
  );
  return { harness, operation: handler(harness.options) };
}

export async function invokeConfigSchema() {
  const harness = createConfigHandlerHarness({ method: "config.schema" });
  await expectDefined(
    configHandlers["config.schema"],
    'configHandlers["config.schema"] test invariant',
  )(harness.options);
  return harness;
}

export async function invokeConfigOpenFile() {
  const harness = createConfigHandlerHarness({ method: "config.openFile" });
  await expectDefined(
    configHandlers["config.openFile"],
    'configHandlers["config.openFile"] test invariant',
  )(harness.options);
  return harness;
}
