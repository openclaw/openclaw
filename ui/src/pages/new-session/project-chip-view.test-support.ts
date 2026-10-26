import { onTestFinished, vi } from "vitest";
import { flush } from "../../test-helpers/solid-settle.ts";
import { createRepositoryFixture } from "./draft-place-state.test-support.ts";
import { mountProjectChip } from "./project-chip.test-support.tsx";

export function projectChipFixture(workspace: string, method: string) {
  const fixture = createRepositoryFixture();
  const { browser, state: place, context, gateway } = fixture;
  Object.assign(gateway, {
    connected: true,
    client: context.gateway.snapshot.client,
    connectionEpoch: 1,
  });
  Object.assign(context.gateway.snapshot.hello!, { features: { methods: [method] } });
  const popoverOpen = vi.spyOn(browser, "popoverOpen").mockReturnValue(true);
  vi.spyOn(place, "folder", "get").mockReturnValue("");
  vi.spyOn(place, "workspacePath").mockReturnValue(workspace);
  vi.spyOn(place, "browseAvailable").mockReturnValue(true);
  vi.spyOn(place, "isAdmin").mockReturnValue(true);
  vi.spyOn(place, "canWrite").mockReturnValue(true);
  vi.spyOn(place, "deviceFolderAvailable", "get").mockReturnValue(false);
  onTestFinished(() => browser.disconnect());
  const mount = (nativeTerminal = () => false) =>
    mountProjectChip(
      fixture,
      () => ({
        folder: "",
        workspace,
        projectId: browser.projectId,
        selectedRemoteProject: browser.remoteProject,
        projects: browser.projects,
        recents: [],
        projectQuery: browser.projectQuery,
      }),
      nativeTerminal,
    );
  return { ...fixture, popoverOpen, mount };
}

export function projectChipQueries(view: ReturnType<typeof mountProjectChip>) {
  const input = () => view.container.querySelector<HTMLInputElement>('input[type="search"]');
  return {
    input,
    remote: (name: string) =>
      view.container.querySelector(`[data-value="remote-project:example/${name}"]`),
    local: () => view.container.querySelector('[data-value="project:sample"]'),
    type(query: string) {
      input()!.value = query;
      input()!.dispatchEvent(new Event("input", { bubbles: true }));
      flush();
    },
  };
}
