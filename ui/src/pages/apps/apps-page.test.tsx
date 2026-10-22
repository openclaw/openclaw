/* @vitest-environment jsdom */

import { getQueriesForElement } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApplicationContext } from "../../app/context-types.ts";
import { i18n } from "../../i18n/index.ts";
import { createApplicationGateway } from "../../test-helpers/application-context-fixtures.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { flush } from "../../test-helpers/solid-settle.ts";
import { AppsPage } from "./apps-page.tsx";

describe("AppsPage", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(() => {
    cleanupSolid();
  });

  it("names the page with one level-one heading above the hero", () => {
    const provider = createSolidApplicationContextProvider({
      gateway: createApplicationGateway().gateway,
      agentSelection: {
        state: { selectedId: null },
        intentRevision: 0,
        subscribe: () => () => undefined,
      },
      navigate: () => undefined,
    } as unknown as ApplicationContext);
    const { container } = mountSolid(() => <AppsPage />, { wrapper: provider.wrapper });
    flush();

    const page = getQueriesForElement(container);
    expect(page.getByRole("heading", { level: 1, name: "Apps" })).toBeTruthy();
    expect(container.querySelectorAll("h1")).toHaveLength(1);
    expect(page.getByRole("heading", { level: 2, name: "Take OpenClaw everywhere" })).toBeTruthy();
  });
});
