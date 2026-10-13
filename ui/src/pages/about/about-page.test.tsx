/* @vitest-environment jsdom */
import { createSignal } from "solid-js";
import { beforeEach, expect, it } from "vitest";
import type { GatewayHelloOk } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { i18n } from "../../i18n/index.ts";
import { ApplicationProvider } from "../../lib/reactive/context.ts";
import { createApplicationGateway } from "../../test-helpers/application-context-fixtures.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { AboutPage } from "./about-page.tsx";

beforeEach(() => i18n.setLocale("en"));

it("follows the replacement Gateway version and ignores the retired source", () => {
  const first = createApplicationGateway();
  const second = createApplicationGateway();
  const publishVersion = (source: typeof first, version: string) => {
    source.publish({
      ...source.gateway.snapshot,
      phase: "connected",
      hello: { server: { version } } as GatewayHelloOk,
    });
  };
  publishVersion(first, "2026.10.1");
  publishVersion(second, "2026.10.2");
  const [gateway, setGateway] = createSignal(first.gateway);
  const context = {
    get gateway() {
      return gateway();
    },
  } as unknown as ApplicationContext;
  const view = mountSolid(() => (
    <ApplicationProvider value={context}>
      <AboutPage />
    </ApplicationProvider>
  ));
  flush();
  expect(view.container.querySelector("openclaw-about-page")).not.toBeNull();
  expect(view.container.textContent).toContain("2026.10.1");
  setGateway(second.gateway);
  flush();
  expect(view.container.textContent).toContain("2026.10.2");
  expect(view.container.textContent).not.toContain("2026.10.1");
  publishVersion(first, "2026.10.3");
  flush();
  expect(view.container.textContent).not.toContain("2026.10.3");
  publishVersion(second, "2026.10.4");
  flush();
  expect(view.container.textContent).toContain("2026.10.4");
});
