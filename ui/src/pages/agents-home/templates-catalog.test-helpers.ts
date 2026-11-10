import { createComponent, createSignal } from "solid-js";
import { onTestFinished } from "vitest";
import { pathForTemplateCatalogEntry } from "../../app-route-paths.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { TemplatesPage } from "../templates/page.tsx";
import { createPage, workflowOperator } from "./agents-home-page.test-helpers.ts";
import { TemplatesCatalogDialog } from "./templates-catalog-dialog.tsx";

export function createDetail(options: Parameters<typeof createPage>[0], version?: string) {
  const fixture = createPage(options);
  void fixture.context.router.navigate(
    "templates",
    fixture.context,
    {},
    {
      pathname: pathForTemplateCatalogEntry(workflowOperator.packageName, ""),
      search: version ? new URLSearchParams({ version }).toString() : "",
      hash: "",
    },
  );
  const [location, setLocation] = createSignal({
    pathname: pathForTemplateCatalogEntry(workflowOperator.packageName, ""),
    search: version ? new URLSearchParams({ version }).toString() : "",
    hash: "",
  });
  const view = mountSolid(
    () =>
      createComponent(TemplatesPage, {
        get routeData() {
          return { location: location(), basePath: "" };
        },
      }),
    { wrapper: fixture.wrapper },
  );
  onTestFinished(view.unmount);
  return {
    ...fixture,
    detail: view.container,
    find: (selector: string) => view.container.querySelector<HTMLElement>(selector),
    setPackageName: (packageName: string) => {
      const nextLocation = {
        pathname: pathForTemplateCatalogEntry(packageName, ""),
        search: version ? new URLSearchParams({ version }).toString() : "",
        hash: "",
      };
      void fixture.context.router.navigate("templates", fixture.context, {}, nextLocation);
      setLocation(nextLocation);
    },
  };
}

export function createAddSurface(
  surface: "card" | "detail" | "modal",
  options: Parameters<typeof createPage>[0],
) {
  if (surface === "detail") {
    return { ...createDetail(options), addSelector: "[data-templates-confirm] button" };
  }
  const fixture = createPage(options);
  if (surface === "modal") {
    const view = mountSolid(
      () =>
        createComponent(TemplatesCatalogDialog, {
          initialPackageName: workflowOperator.packageName,
          modal: true,
        }),
      { wrapper: fixture.wrapper },
    );
    onTestFinished(view.unmount);
    return {
      ...fixture,
      detail: view.container,
      find: (selector: string) => view.container.querySelector<HTMLElement>(selector),
      addSelector: "button[data-templates-confirm]",
    };
  }
  return {
    ...fixture,
    detail: fixture.page,
    find: (selector: string) => fixture.page.querySelector<HTMLElement>(selector),
    addSelector: ".agents-home__template-add",
  };
}
