import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { parse } from "acorn";

export type WidgetScript = { body: string; sourceType: "script" | "module" };

export function parseWidgetScript({ body, sourceType }: WidgetScript) {
  try {
    parse(body, { ecmaVersion: "latest", sourceType });
  } catch (error) {
    if (!(error instanceof SyntaxError) || !("pos" in error) || typeof error.pos !== "number") {
      throw error;
    }
    return {
      pos: error.pos,
      message: truncateUtf16Safe(error.message.replace(/ \(\d+:\d+\)$/u, ""), 200),
    };
  }
  return undefined;
}
