// @vitest-environment jsdom
import { expect, it, onTestFinished, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { PersonalEnrollment } from "./personal-enrollment.tsx";
import { createConnectedContext } from "./profile-page.test-support.tsx";

it("does not mount another setup card or load its directory for an admitted personal identity", () => {
  const request = vi.fn().mockResolvedValue({ profiles: [] });
  const { context } = createConnectedContext(request, { id: "existing-person", name: "Ada" });
  const view = mountSolid(() => (
    <PersonalEnrollment
      initialGateway={context.gateway}
      basePath=""
      onboarding
      onLater={() => undefined}
    />
  ));
  onTestFinished(view.unmount);
  flush();
  expect(view.container.querySelector(".personal-enrollment")).toBeNull();
  expect(view.container.querySelector(".custodian-setup__personal")).toBeNull();
  expect(view.container.querySelector("h3, button")).toBeNull();
  expect(request).not.toHaveBeenCalled();
});
