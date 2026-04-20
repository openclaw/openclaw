import { loadBundledPluginContractApiSync } from "../../../src/test-utils/bundled-plugin-public-surface.js";
import { createLazyObjectSurface } from "./lazy-object-surface.js";

type MatrixContractSurface = {
  matrixSetupAdapter: Record<string, unknown>;
  matrixSetupWizard: Record<string, unknown>;
};

let matrixContractSurface: MatrixContractSurface | undefined;

function getMatrixContractSurface(): MatrixContractSurface {
  matrixContractSurface ??= loadBundledPluginContractApiSync<MatrixContractSurface>("matrix");
  return matrixContractSurface;
}

export const matrixSetupAdapter = createLazyObjectSurface(
  () => getMatrixContractSurface().matrixSetupAdapter,
);

export const matrixSetupWizard = createLazyObjectSurface(
  () => getMatrixContractSurface().matrixSetupWizard,
);
