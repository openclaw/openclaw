import { expect, test, vi } from "vitest";
import {
  getActiveMemoryProviderCore,
  getMemorySearchManager,
  invokeDoctorMemory,
  resolveActiveMemoryBackendConfig,
  respondPayload,
} from "./doctor.test-support.js";

test("doctor.memory.status reports native provider health without probing legacy embeddings", async () => {
  const close = vi.fn().mockResolvedValue(undefined);
  const health = vi.fn().mockResolvedValue({ status: "degraded", message: "warming" });
  resolveActiveMemoryBackendConfig.mockReturnValue({
    backend: "provider-runtime",
    providerId: "records",
  });
  getActiveMemoryProviderCore.mockResolvedValue({
    providerId: "records",
    provider: { health, close },
  });
  const respond = vi.fn();

  await invokeDoctorMemory("doctor.memory.status", respond);

  expect(getMemorySearchManager).not.toHaveBeenCalled();
  expect(health).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
  expect(respondPayload(respond)).toMatchObject({
    agentId: "main",
    provider: "records",
    health: { status: "degraded", message: "warming" },
    embedding: { checked: false },
  });
});
