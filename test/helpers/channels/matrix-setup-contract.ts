import { loadBundledPluginContractApiSync } from "../../../src/test-utils/bundled-plugin-public-surface.js";

type MatrixContractSurface = typeof import("@openclaw/matrix/contract-api.js");

const { matrixSetupAdapter, matrixSetupWizard } =
  loadBundledPluginContractApiSync<MatrixContractSurface>("matrix");

export { matrixSetupAdapter, matrixSetupWizard };
