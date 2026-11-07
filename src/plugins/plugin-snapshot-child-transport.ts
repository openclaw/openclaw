import type { MessagePort } from "node:worker_threads";
import { z } from "zod";
import { PluginSourceSnapshotDescriptorSchema } from "./plugin-source-snapshot.types.js";

const ChildEntrySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("file"), filename: z.string() }),
  z.strictObject({
    kind: z.literal("source"),
    filename: z.string(),
    source: z.string(),
    format: z.enum(["module", "commonjs"]),
  }),
]);

/** Private launch envelope. The host retains physical custody until child exit. */
export const PluginSnapshotChildEnvelopeSchema = z.strictObject({
  version: z.literal(1),
  id: z.string(),
  stateDir: z.string(),
  descriptor: PluginSourceSnapshotDescriptorSchema,
  entry: ChildEntrySchema,
  execArgv: z.array(z.string()),
  argv: z.array(z.string()),
  nodeOptions: z.string().nullable(),
});
export type PluginSnapshotChildEnvelope = z.infer<typeof PluginSnapshotChildEnvelopeSchema>;
export type PluginSnapshotChildWorkerData = {
  envelope: PluginSnapshotChildEnvelope;
  value: unknown;
  control: MessagePort;
};

export type PluginSnapshotChildFailure = { artifactPath: string; message: string };
export type PluginSnapshotChildControl = {
  snapshotChild: string;
  failure: PluginSnapshotChildFailure;
};

export const PLUGIN_SNAPSHOT_CHILD_ARG = "--openclaw-plugin-snapshot-child";
