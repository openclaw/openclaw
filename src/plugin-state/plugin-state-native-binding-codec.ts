import type {
  PluginStateNativeBindingPlan,
  PluginStateNativeBindingRecord,
} from "./plugin-state-native-binding.types.js";

type NativeBindingArtifact = {
  readNativeSessionBindingRecord: (value: unknown) => PluginStateNativeBindingRecord | undefined;
};

type CodecPlan = Pick<PluginStateNativeBindingPlan, "codec" | "codecSource">;
const codecs = new Map<string, NativeBindingArtifact>();

function codecKey({ codec, codecSource }: CodecPlan): string {
  return [codec, codecSource?.origin, codecSource?.rootDir, codecSource?.source].join("\0");
}

/** Load the plugin's canonical codec before the executor takes either database write lock. */
export async function preparePluginStateNativeBindingCodec(
  plan: CodecPlan,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  const key = codecKey(plan);
  if (codecs.has(key)) {
    return;
  }
  const { loadBundledPluginPublicArtifactModuleFromCandidatesSync } =
    await import("../plugins/public-surface-loader.js");
  const artifact = loadBundledPluginPublicArtifactModuleFromCandidatesSync<NativeBindingArtifact>({
    dirName: plan.codec,
    artifactCandidates: ["native-session-binding-api.js"],
    env,
    ...(plan.codecSource ? { owner: { id: plan.codec, ...plan.codecSource } } : {}),
  });
  if (typeof artifact?.readNativeSessionBindingRecord !== "function") {
    throw new Error(`Native session binding codec is unavailable: ${plan.codec}`);
  }
  codecs.set(key, artifact);
}

export function readPreparedPluginStateNativeBinding(
  plan: CodecPlan,
  value: unknown,
): PluginStateNativeBindingRecord | undefined {
  const artifact = codecs.get(codecKey(plan));
  if (!artifact) {
    throw new Error(`Native session binding codec was not prepared: ${plan.codec}`);
  }
  return artifact.readNativeSessionBindingRecord(value);
}
