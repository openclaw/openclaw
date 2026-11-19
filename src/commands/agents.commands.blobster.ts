import fs from "node:fs/promises";
import path from "node:path";
import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import {
  MAX_BLOBSTER_DESIGN_CHARS,
  renderBlobsterSvgFromDesignText,
} from "../agents/blobster-generation.js";
import { throwExpectedCliError } from "../cli/expected-cli-error.js";
import { formatErrorMessage } from "../infra/errors.js";
import { expandHomePrefix } from "../infra/home-dir.js";
import { defaultRuntime as runtime, writeRuntimeJson } from "../runtime.js";
import { shortenHomePath } from "../utils.js";
import { readBoundedCliTextInput } from "./agent-message-input.js";

const MAX_DESIGN_INPUT_BYTES = MAX_BLOBSTER_DESIGN_CHARS * 4;

export async function agentsRenderBlobsterCommand(opts: {
  design: string;
  out: string;
  json?: boolean;
}) {
  const designInput = readNonBlankString(opts.design);
  if (!designInput) {
    throwExpectedCliError("Design path must not be blank");
  }
  const outInput = readNonBlankString(opts.out);
  if (!outInput) {
    throwExpectedCliError("--out must not be blank");
  }

  const outPath = path.resolve(expandHomePrefix(outInput));
  const ext = path.extname(outPath).toLowerCase();
  if (ext !== ".svg" && ext !== ".png") {
    throwExpectedCliError("--out must end with .svg or .png");
  }
  const format = ext === ".png" ? "png" : "svg";

  let rawDesign: string;
  try {
    rawDesign = await readBoundedCliTextInput(
      designInput === "-" ? "-" : expandHomePrefix(designInput),
      { maxBytes: MAX_DESIGN_INPUT_BYTES, label: "Design" },
    );
  } catch (error) {
    throwExpectedCliError(formatErrorMessage(error));
  }

  let rendered: ReturnType<typeof renderBlobsterSvgFromDesignText>;
  try {
    rendered = renderBlobsterSvgFromDesignText(rawDesign);
  } catch (error) {
    throwExpectedCliError(`Invalid Blobster design: ${formatErrorMessage(error)}`);
  }

  let payload: Buffer;
  if (format === "png") {
    const { Resvg } = await import("@resvg/resvg-js");
    payload = new Resvg(rendered.svg, { font: { loadSystemFonts: false } }).render().asPng();
  } else {
    payload = Buffer.from(rendered.svg, "utf8");
  }

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, payload);

  if (opts.json) {
    writeRuntimeJson(runtime, {
      id: rendered.id,
      name: rendered.name,
      description: rendered.description,
      out: outPath,
      format,
      bytes: payload.byteLength,
    });
    return;
  }

  runtime.log(`Name: ${sanitizeTerminalText(rendered.name)}`);
  runtime.log(`Output: ${sanitizeTerminalText(shortenHomePath(outPath))}`);
  runtime.log(`Bytes: ${payload.byteLength}`);
}
