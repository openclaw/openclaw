import type { ContextVisibilityMode } from "../../config/types.base.js";
import type { InboundMediaFacts, SupplementalContextFacts } from "../turn/types.js";
import { filterChannelInboundSupplementalContext } from "./context.js";

type MaybePromise<T> = T | Promise<T>;
type ChannelInboundSupplementalMediaResolver = () => MaybePromise<
  readonly InboundMediaFacts[] | null | undefined
>;
type ChannelInboundSupplementalQuoteFacts = NonNullable<SupplementalContextFacts["quote"]> & {
  isSelf?: boolean;
  media?: readonly InboundMediaFacts[] | ChannelInboundSupplementalMediaResolver;
};
type ChannelInboundSupplementalFacts = Omit<SupplementalContextFacts, "quote"> & {
  quote?: ChannelInboundSupplementalQuoteFacts;
};
type ResolveChannelInboundSupplementalContextParams = {
  supplemental?: ChannelInboundSupplementalFacts;
  contextVisibility?: ContextVisibilityMode;
  media?: readonly InboundMediaFacts[];
  suppressSelfQuoteBody?: boolean;
  suppressSelfQuoteMedia?: boolean;
};

export async function resolveChannelInboundSupplementalContext(
  params: ResolveChannelInboundSupplementalContextParams,
): Promise<{
  supplemental?: SupplementalContextFacts;
  media: InboundMediaFacts[];
  quoteHidden: boolean;
}> {
  const media = [...(params.media ?? [])];
  if (!params.supplemental) {
    return { media, quoteHidden: false };
  }

  const rawQuote = params.supplemental.quote;
  const filtered = filterChannelInboundSupplementalContext({
    supplemental: params.supplemental,
    contextVisibility: params.contextVisibility,
  });
  const visibleQuote = filtered?.quote as ChannelInboundSupplementalQuoteFacts | undefined;
  if (!rawQuote || !visibleQuote) {
    return { supplemental: filtered, media, quoteHidden: Boolean(rawQuote) };
  }

  const suppressSelfQuoteBody = params.suppressSelfQuoteBody ?? true;
  const selfQuote = visibleQuote.isSelf === true;
  if (!(selfQuote && (params.suppressSelfQuoteMedia ?? true))) {
    const quoteMedia =
      typeof visibleQuote.media === "function" ? await visibleQuote.media() : visibleQuote.media;
    media.push(...(quoteMedia ?? []));
  }
  const { media: _media, isSelf: _isSelf, ...quote } = visibleQuote;
  if (selfQuote) {
    const { body: _body, ...quoteWithoutBody } = quote;
    return {
      supplemental: {
        ...filtered,
        quote: suppressSelfQuoteBody ? quoteWithoutBody : quote,
      },
      media,
      quoteHidden: false,
    };
  }

  return {
    supplemental: {
      ...filtered,
      quote,
    },
    media,
    quoteHidden: false,
  };
}
