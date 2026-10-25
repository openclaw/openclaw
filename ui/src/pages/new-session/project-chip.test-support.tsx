import { createMemo, createSignal } from "solid-js";
import { vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import type { createRepositoryFixture } from "./draft-place-state.test-support.ts";
import { resolveProjectChip } from "./project-chip.ts";
import { ProjectChip } from "./project-chip.tsx";
import type { NewSessionPlaceControlsOptions } from "./target-controls.ts";

export function mountProjectChip(
  fixture: ReturnType<typeof createRepositoryFixture>,
  state: () => Parameters<typeof resolveProjectChip>[0],
  nativeTerminal = () => false,
) {
  const { state: place, gateway, context, changed } = fixture;
  const params: NewSessionPlaceControlsOptions = {
    place,
    gateway,
    context,
    data: undefined,
    submitting: false,
    pendingPlacement: false,
    onConnectMachine: vi.fn(),
    onNavigate: vi.fn(),
    onFocusComposer: vi.fn(),
    onChange: changed,
  };
  return mountSolid(() => {
    const [revision, setRevision] = createSignal(0);
    changed.mockImplementation(() => setRevision((value) => value + 1));
    const props = createMemo(() => {
      revision();
      return {
        params: { ...params },
        state: resolveProjectChip(state()),
        nativeTerminal: nativeTerminal(),
      };
    });
    return <ProjectChip {...props()} />;
  });
}
