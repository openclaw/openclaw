import { z } from "zod";
import type { SchemaContract } from "../../packages/gateway-protocol/src/schema-contract.js";

export const SourceAdmissionReceiptSchema = z.object({
  signature: z.string().min(1),
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  nativeArtifacts: z.record(
    z.string(),
    z.object({
      sourceIdentity: z.string().min(1),
      contentHash: z.string().regex(/^[a-f0-9]{64}$/),
      sizeBytes: z.number().int().nonnegative().safe(),
      capturedPath: z.string().min(1),
      namespace: z.string().min(1),
      capturedIdentity: z.string().min(1),
    }),
  ),
  nativeNamespaces: z.record(
    z.string(),
    z.object({
      sourceDirectory: z.string().min(1),
      capturedRoot: z.string().min(1),
      managed: z.boolean(),
      /** Original immutable npm directory, retained by the install-generation owner. */
      referenceRoot: z.string().min(1).optional(),
      members: z.record(
        z.string(),
        z.object({
          source: z.string().min(1),
          sourceIdentity: z.string().min(1),
          capturedIdentity: z.string().min(1),
          boundaryChecked: z.boolean(),
          contentHash: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
          sizeBytes: z.number().int().nonnegative().safe().optional(),
        }),
      ),
    }),
  ),
});

export type PluginSourceAdmissionReceipt = SchemaContract<
  z.infer<typeof SourceAdmissionReceiptSchema>
>;
export type PluginNativeArtifactFact = PluginSourceAdmissionReceipt["nativeArtifacts"][string];
export type PluginNativeNamespaceFact = PluginSourceAdmissionReceipt["nativeNamespaces"][string];

export type PluginSourceAdmissionPublication = {
  pluginId: string;
  rootDir: string;
  installRecordHash?: string;
  key: string;
  receipt: PluginSourceAdmissionReceipt;
};
