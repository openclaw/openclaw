/* @vitest-environment jsdom */
import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../app/context-types.ts";
import { composerFileReferenceFixture } from "../../lib/chat/file-references.test-support.ts";
import type { ComposerFileReference } from "../../lib/chat/file-references.ts";
import {
  createApplicationGateway,
  createApplicationGatewaySnapshot,
} from "../../test-helpers/application-context-fixtures.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { ComposerPluginPromptSlot } from "./components/chat-composer-plugin-prompt-slot.tsx";

it("keeps a file named github out of the plugin namespace until explicit conversion", async () => {
  const request = createGatewayRequestMock(async () => ({
    plugins: [
      {
        id: "github",
        name: "GitHub",
        installed: true,
        enabled: true,
        state: "enabled",
        hasIcon: false,
      },
    ],
    diagnostics: [],
    mutationAllowed: false,
  }));
  const { gateway } = createApplicationGateway(
    createApplicationGatewaySnapshot({
      client: createTestGatewayClient(request),
      phase: "connected",
      hello: gatewayHelloForMethods(["plugins.list"]),
    }),
  );
  // This slot consumes only the authenticated Gateway and icon resource base path.
  const context = { gateway, resourceBasePath: "" } as ApplicationContext;
  const { wrapper } = createSolidApplicationContextProvider(context);
  const [references, setReferences] = createSignal<readonly ComposerFileReference[]>([
    {
      ...composerFileReferenceFixture,
      end: 7,
      reference: {
        ...composerFileReferenceFixture.reference,
        relativePath: "github",
        displayLabel: "github",
      },
    },
  ]);
  const mounted = mountSolid(
    () => (
      <ComposerPluginPromptSlot
        text="@github review"
        fileReferences={references()}
        disabled={false}
      />
    ),
    { wrapper },
  );
  await vi.dynamicImportSettled();
  flush();
  expect(request).not.toHaveBeenCalled();
  expect(mounted.container.querySelector(".agent-chat__plugin-draft-overlay")).toBeNull();
  setReferences([]);
  await vi.dynamicImportSettled();
  await waitForSolid(() => expect(request).toHaveBeenCalledExactlyOnceWith("plugins.list", {}));
  expect(mounted.container.querySelector(".agent-chat__plugin-draft-overlay")?.textContent).toBe(
    "@github review",
  );
});
