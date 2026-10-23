import "./session-controller.js";
import { resetSessionControllerStorageForTest } from "./session-controller-storage-reset.test-support.js";

export const testing = {
  resetSessionControllerForTest: resetSessionControllerStorageForTest,
};
