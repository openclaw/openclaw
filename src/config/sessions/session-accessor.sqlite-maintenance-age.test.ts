import { expect, it, vi } from "vitest";
import {
  observeSessionEntryMaintenanceAgeChanges,
  publishSessionEntryMaintenanceAgeChanges,
} from "./session-accessor.sqlite-maintenance-age.js";

it("keeps replacement maintenance observers subscribed after repeated old cleanup", () => {
  const identity = Symbol("maintenance-observers");
  const previous = vi.fn();
  const stopPrevious = observeSessionEntryMaintenanceAgeChanges(identity, previous);
  stopPrevious();

  const current = vi.fn();
  const stopCurrent = observeSessionEntryMaintenanceAgeChanges(identity, current);
  const change = { sessionKey: "agent:main:observed", entry: { updatedAt: 1 } };
  try {
    stopPrevious();
    publishSessionEntryMaintenanceAgeChanges(identity, [change]);
    expect(previous).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledExactlyOnceWith(change);
    stopCurrent();
    publishSessionEntryMaintenanceAgeChanges(identity, [change]);
    expect(current).toHaveBeenCalledTimes(1);
  } finally {
    stopCurrent();
  }
});
