import { TEXT_SCALE_STOPS, type TextScaleStop } from "./settings-contract.ts";

type IosTextScaleWindow = Window & {
  __OPENCLAW_NATIVE_EMBED__?: { platform?: string; textScale?: TextScaleStop };
  webkit?: { messageHandlers?: { openclawTextScale?: { postMessage(value: number): void } } };
};

function iosTextScaleHost() {
  if (typeof window === "undefined") {
    return;
  }
  const native = window as IosTextScaleWindow;
  const embed = native.__OPENCLAW_NATIVE_EMBED__;
  const handler = native.webkit?.messageHandlers?.openclawTextScale;
  if (
    embed?.platform === "ios" &&
    embed.textScale !== undefined &&
    TEXT_SCALE_STOPS.includes(embed.textScale) &&
    handler
  ) {
    return { embed, handler };
  }
}

export function readIosTextScale(): TextScaleStop | undefined {
  return iosTextScaleHost()?.embed.textScale;
}

export function writeIosTextScale(scale: TextScaleStop): void {
  const host = iosTextScaleHost();
  if (host) {
    host.handler.postMessage(scale);
    host.embed.textScale = scale;
  }
}
