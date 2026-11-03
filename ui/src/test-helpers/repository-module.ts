import { loadControlUiPluginFixture } from "./control-ui-plugin-module.ts";

export const repositoryUi = await loadControlUiPluginFixture(
  new URL("../../../extensions/github-repositories/package.json", import.meta.url),
);
