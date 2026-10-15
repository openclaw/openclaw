/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import { GatewayBrowserClient } from "../../api/gateway.ts";
import * as toasts from "../../lib/toast.ts";
import { UsagePageModel } from "./usage-page-model.ts";
import { contextWithClient } from "./usage-page.test-support.ts";

afterEach(() => vi.restoreAllMocks());

it.each(["disconnect", "replacement"] as const)(
  "keeps export failure feedback scoped to its operator after %s",
  async (change) => {
    const response = Promise.withResolvers<unknown>();
    const client = new GatewayBrowserClient({ url: "ws://test.invalid" });
    vi.spyOn(client, "request").mockReturnValue(response.promise);
    const context = contextWithClient(client);
    const model = new UsagePageModel(context, () => {});
    const toast = vi.spyOn(toasts, "showToast").mockReturnValue(true);
    model.connect();
    try {
      model.read().callbacks.display.onExportCsv("sessions-csv");
      expect(model.read().data.exporting).toBe(true);
      context.setGatewaySnapshot(
        change === "disconnect"
          ? { phase: "reconnecting" }
          : { client: new GatewayBrowserClient({ url: "ws://replacement.invalid" }) },
      );
      response.reject(new Error("Connection lost during export"));
      await response.promise.catch(() => {});
      expect(model.read().data.exporting).toBe(false);
      if (change === "disconnect") {
        expect(toast).toHaveBeenCalledWith({ message: "Export: Connection lost during export" });
      } else {
        expect(toast).not.toHaveBeenCalled();
      }
    } finally {
      model.dispose();
    }
  },
);
