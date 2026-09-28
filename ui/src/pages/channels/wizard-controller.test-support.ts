// Shared fixtures for the channel wizard controller suites.
import { vi } from "vitest";
import { ChannelWizardController } from "./wizard-controller.ts";

type RequestHandler = (
  method: string,
  params?: unknown,
  options?: { timeoutMs?: number | null; signal?: AbortSignal },
) => Promise<unknown>;

export function createWizardTestController(handler: RequestHandler) {
  const request = vi.fn(handler);
  const onChange = vi.fn();
  const client = { request: request as never };
  const controller = new ChannelWizardController(
    () => client,
    onChange,
    () => false,
    () => "Setup expired. Close and restart setup.",
  );
  return { controller, request, onChange };
}

export const tokenStep = {
  id: "step-token",
  type: "text" as const,
  message: "Paste token",
  sensitive: true,
};
