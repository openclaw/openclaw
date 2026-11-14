import { describe, expect, it } from "vitest";
import { resolveCronExecutionRetryHint } from "./retry-hint.js";

describe("cron HTTP status retry hints", () => {
  it.each(["HTTP/1.1 503", "HTTP/2 502", "HTTP/3 504", "HTTP 503"])(
    "retries an HTTP server failure (%s)",
    (error) => {
      expect(resolveCronExecutionRetryHint({ error })).toEqual({
        retryable: true,
        category: "server_error",
      });
    },
  );

  it.each(["HTTP/2 5030", "context limit 503 exceeded"])(
    "ignores a number that is not an HTTP server status (%s)",
    (error) => {
      expect(resolveCronExecutionRetryHint({ error })).toEqual({ retryable: false });
    },
  );
});
