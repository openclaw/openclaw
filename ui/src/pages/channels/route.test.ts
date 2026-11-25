import type { RouteLoaderOptions } from "@openclaw/uirouter";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ApplicationContext } from "../../app/context.ts";
import { page } from "./route.ts";

it.each(["channels", "config"] as const)(
  "starts config immediately and waits for both reads when %s finishes first",
  async (first) => {
    const channelsLoaded = createDeferred();
    const configLoaded = createDeferred();
    const refresh = vi.fn(() => channelsLoaded.promise);
    const ensureLoaded = vi.fn(() => configLoaded.promise);
    const ensureSchemaLoaded = vi.fn(async () => {});
    const acquireChannels = vi.fn(() => ({ refresh }));
    const context = {
      acquireChannels,
      runtimeConfig: { ensureLoaded, ensureSchemaLoaded },
    } as unknown as ApplicationContext; // SAFETY: The loader only reads the two mocked capabilities.
    const options: RouteLoaderOptions = {
      signal: new AbortController().signal,
      shouldRun: () => true,
      revalidating: false,
      location: { pathname: "/settings/channels", search: "", hash: "" },
      deps: "channels",
      cause: "navigation",
    };
    if (!page.loader) {
      throw new Error("channels route has no loader");
    }

    expect(page.loader(context, options)).toBeUndefined();
    expect(ensureLoaded).toHaveBeenCalledOnce();
    expect(acquireChannels).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledExactlyOnceWith(false));

    const reads = { channels: channelsLoaded, config: configLoaded };
    reads[first].resolve();
    await Promise.resolve();
    expect(ensureSchemaLoaded).not.toHaveBeenCalled();

    reads[first === "channels" ? "config" : "channels"].resolve();
    await vi.waitFor(() => expect(ensureSchemaLoaded).toHaveBeenCalledOnce());
  },
);
