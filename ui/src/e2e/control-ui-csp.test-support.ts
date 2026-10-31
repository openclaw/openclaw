import type { Route } from "playwright";
import {
  buildControlUiCspHeader,
  computeInlineScriptHashes,
} from "../../../src/gateway/control-ui-csp.ts";

export async function fulfillWithControlUiCsp(
  route: Route,
  headerName: "content-security-policy" | "Content-Security-Policy" = "content-security-policy",
) {
  const response = await route.fetch();
  const body = await response.text();
  await route.fulfill({
    response,
    body,
    headers: {
      ...response.headers(),
      [headerName]: buildControlUiCspHeader({
        inlineScriptHashes: computeInlineScriptHashes(body),
      }),
    },
  });
}
