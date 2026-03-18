import type { ChannelResolveResult } from "./types.adapters.js";

export function buildUnresolvedTargetResults(
  inputs: string[],
  note: string,
): ChannelResolveResult[] {
  return inputs.map((input) => ({
    input,
    resolved: false,
    note,
  }));
}

export async function resolveTargetsWithOptionalToken<TResult>(params: {
  token?: string | null;
  inputs: string[];
  missingTokenNote: string;
  resolveWithToken: (params: { token: string; inputs: string[] }) => Promise<TResult[]>;
  mapResolved: (entry: TResult) => ChannelResolveResult;
}): Promise<ChannelResolveResult[]> {
  const token = params.token?.trim();
  if (!token) {
    return buildUnresolvedTargetResults(params.inputs, params.missingTokenNote);
  }
  const resolved = await params.resolveWithToken({
    token,
    inputs: params.inputs,
  });
  return resolved.map(params.mapResolved);
}
