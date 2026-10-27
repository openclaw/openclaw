import { AsyncResource } from "node:async_hooks";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { runWithGatewayHttpWorkAdmission } from "../../server/http-work-admission.js";

export function createTalkClientOfferFixture() {
  const resources: AsyncResource[] = [];

  async function completeOffer(run?: (resource: AsyncResource) => Promise<void>) {
    const socket = new Socket();
    const res = new ServerResponse(new IncomingMessage(socket));
    let resource!: AsyncResource;
    try {
      await runWithGatewayHttpWorkAdmission(res, async () => {
        // A socket captures its creator's async context; a retained plain closure does not.
        resource = new AsyncResource("talk-sideband-test");
        resources.push(resource);
        await run?.(resource);
        return true;
      });
      return resource;
    } finally {
      socket.destroy();
    }
  }

  function disposeResources() {
    for (const resource of resources.splice(0)) {
      resource.emitDestroy();
    }
  }

  return { completeOffer, disposeResources };
}
