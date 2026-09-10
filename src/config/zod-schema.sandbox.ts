import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { z } from "zod";
import { splitSandboxBindSpec } from "../agents/sandbox/bind-spec.js";
import { isSandboxHostPathAbsolute } from "../agents/sandbox/host-paths.js";
import { getBlockedNetworkModeReason } from "../agents/sandbox/network-mode.js";

function validateSandboxBindEntries(
  binds: readonly string[] | undefined,
  ctx: z.RefinementCtx,
): void {
  if (!binds) {
    return;
  }
  for (let i = 0; i < binds.length; i += 1) {
    const bind = binds[i]?.trim() ?? "";
    if (!bind) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["binds", i],
        message: "Sandbox security: bind mount entry must be a non-empty string.",
      });
      continue;
    }
    const parsed = splitSandboxBindSpec(bind);
    const source = (parsed ? parsed.host : bind).trim();
    if (!isSandboxHostPathAbsolute(source)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["binds", i],
        message:
          `Sandbox security: bind mount "${bind}" uses a non-absolute source path "${source}". ` +
          "Only absolute POSIX or Windows drive-letter paths are supported for sandbox binds.",
      });
    }
  }
}

export const SandboxDockerSchema = z
  .object({
    image: z.string().optional(),
    containerPrefix: z.string().optional(),
    workdir: z.string().optional(),
    readOnlyRoot: z.boolean().optional(),
    tmpfs: z.array(z.string()).optional(),
    network: z.string().optional(),
    user: z.string().optional(),
    capDrop: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    setupCommand: z
      .union([z.string(), z.array(z.string())])
      .transform((value) => (Array.isArray(value) ? value.join("\n") : value))
      .pipe(z.string())
      .optional(),
    pidsLimit: z.number().int().positive().optional(),
    memory: z.union([z.string(), z.number()]).optional(),
    memorySwap: z.union([z.string(), z.number()]).optional(),
    cpus: z.number().positive().optional(),
    gpus: z.string().min(1).optional(),
    ulimits: z
      .record(
        z.string(),
        z.union([
          z.string(),
          z.number(),
          z
            .object({
              soft: z.number().int().nonnegative().optional(),
              hard: z.number().int().nonnegative().optional(),
            })
            .strict(),
        ]),
      )
      .optional(),
    seccompProfile: z.string().optional(),
    apparmorProfile: z.string().optional(),
    dns: z.array(z.string()).optional(),
    extraHosts: z.array(z.string()).optional(),
    binds: z.array(z.string()).optional(),
    dangerouslyAllowReservedContainerTargets: z.boolean().optional(),
    dangerouslyAllowExternalBindSources: z.boolean().optional(),
    dangerouslyAllowContainerNamespaceJoin: z.boolean().optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    validateSandboxBindEntries(data.binds, ctx);
    const blockedNetworkReason = getBlockedNetworkModeReason({
      network: data.network,
      allowContainerNamespaceJoin: data.dangerouslyAllowContainerNamespaceJoin === true,
    });
    if (blockedNetworkReason === "host") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["network"],
        message:
          'Sandbox security: network mode "host" is blocked. Use "bridge" or "none" instead.',
      });
    }
    if (blockedNetworkReason === "container_namespace_join") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["network"],
        message:
          'Sandbox security: network mode "container:*" is blocked by default. ' +
          "Use a custom bridge network, or set dangerouslyAllowContainerNamespaceJoin=true only when you fully trust this runtime.",
      });
    }
    if (normalizeLowercaseStringOrEmpty(data.seccompProfile ?? "") === "unconfined") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["seccompProfile"],
        message:
          'Sandbox security: seccomp profile "unconfined" is blocked. ' +
          "Use a custom seccomp profile file or omit this setting.",
      });
    }
    if (normalizeLowercaseStringOrEmpty(data.apparmorProfile ?? "") === "unconfined") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["apparmorProfile"],
        message:
          'Sandbox security: AppArmor profile "unconfined" is blocked. ' +
          "Use a named AppArmor profile or omit this setting.",
      });
    }
  })
  .optional();

export const SandboxBrowserSchema = z
  .object({
    enabled: z.boolean().optional(),
    image: z.string().optional(),
    containerPrefix: z.string().optional(),
    network: z.string().optional(),
    cdpPort: z.number().int().positive().optional(),
    cdpSourceRange: z.string().optional(),
    vncPort: z.number().int().positive().optional(),
    noVncPort: z.number().int().positive().optional(),
    headless: z.boolean().optional(),
    noVncEnabled: z.boolean().optional(),
    allowHostControl: z.boolean().optional(),
    autoStart: z.boolean().optional(),
    autoStartTimeoutMs: z.number().int().positive().optional(),
    binds: z.array(z.string()).optional(),
  })
  .superRefine((data, ctx) => {
    validateSandboxBindEntries(data.binds, ctx);
    if (normalizeLowercaseStringOrEmpty(data.network ?? "") === "host") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["network"],
        message:
          'Sandbox security: browser network mode "host" is blocked. Use "bridge" or a custom bridge network instead.',
      });
    }
  })
  .strict()
  .optional();

export const SandboxPruneSchema = z
  .object({
    idleHours: z.number().int().nonnegative().optional(),
    maxAgeDays: z.number().int().nonnegative().optional(),
  })
  .strict()
  .optional();
