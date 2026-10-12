import type { ControlUiLinkPreview } from "../../../../../src/gateway/control-ui-contract.js";

/** Adapts existing anonymous page metadata; never fetches or embeds remote markup. */
export function browserTabTweet(url: string, title?: string, page?: ControlUiLinkPreview) {
  const parsed = URL.parse(url);
  if (
    !parsed ||
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    !/^(?:(?:www|mobile)\.)?(?:x|twitter)\.com$/u.test(parsed.hostname)
  ) {
    return undefined;
  }
  const status = /^\/([a-zA-Z0-9_]{1,15})\/status\/\d+(?:\/(?:photo|video)\/\d+)?\/?$/u.exec(
    parsed.pathname,
  );
  const anonymous = /^\/i\/(?:web\/)?status\/\d+\/?$/u.test(parsed.pathname);
  if (!status && !anonymous) {
    return undefined;
  }
  let handle = anonymous ? undefined : status?.[1];
  let author: string | undefined;
  let text: string | undefined;
  for (const candidate of [page?.title, title]) {
    const clean = candidate?.trim().replace(/\s+\/\s+(?:X|Twitter)$/u, "");
    if (!clean) {
      continue;
    }
    const named =
      /^(.*?)\s+\(@([a-zA-Z0-9_]{1,15})\)(?:\s+on (?:X|Twitter))?(?::\s*([\s\S]+))?$/u.exec(clean);
    if (named && (!handle || named[2]!.toLowerCase() === handle.toLowerCase())) {
      author ??= named[1]?.trim() || undefined;
      handle ??= named[2];
      text ??= named[3];
    }
    const quoted = /^(.*?)\s+on (?:X|Twitter):\s*([\s\S]+)$/u.exec(clean);
    if (quoted && !named) {
      author ??= quoted[1]?.trim() || undefined;
      text ??= quoted[2];
    }
  }
  text = text?.trim();
  if (
    text &&
    ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("“") && text.endsWith("”")))
  ) {
    text = text.slice(1, -1);
  }
  return {
    author,
    handle: handle ? "@" + handle : undefined,
    text: page?.description?.trim() || text,
  };
}
