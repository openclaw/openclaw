import { createControlUiSessionRow } from "./control-ui-session-fixtures.ts";

export function createControlUiMockSessionRow(
  key: string,
  label: string,
  updatedAt: number,
  options?: { model?: string; modelProvider?: string } & Record<string, unknown>,
) {
  return createControlUiSessionRow(
    key,
    label,
    updatedAt,
    Object.assign({ contextTokens: 200_000 }, options, {
      model: options?.model ?? "gpt-5-mini",
      modelProvider: options?.modelProvider ?? "openai",
    }),
  );
}
