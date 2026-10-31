import { discoveryModuleGate } from "../../model-providers/discovery-controller.test-support.ts";

await discoveryModuleGate.promise;

export function ModelSetupPage(props: { agentLabel: string; onClose: () => void }) {
  return (
    <button data-setup onClick={() => props.onClose()}>
      {props.agentLabel}
    </button>
  );
}
