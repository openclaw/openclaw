import { installWindowsCIOutputSanitizer } from "./windows-ci-output-sanitizer";

export default function globalSetup() {
  installWindowsCIOutputSanitizer();
}
