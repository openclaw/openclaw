import { expectTypeOf } from "vitest";
import type { transitionOwnedDeliveryQueueEntryInDatabase } from "../../src/infra/delivery-queue-sqlite-claim.kernel.js";

type OwnedDeliveryTransition = Parameters<typeof transitionOwnedDeliveryQueueEntryInDatabase>[2];

// requires an explicitly synchronous owned delivery transition
const transition: OwnedDeliveryTransition = () => {};
expectTypeOf(transition).returns.toEqualTypeOf<undefined>();
expectTypeOf<() => Promise<void>>().not.toExtend<OwnedDeliveryTransition>();
expectTypeOf<() => PromiseLike<undefined>>().not.toExtend<OwnedDeliveryTransition>();
// A void callback could have erased an async implementation's Promise return.
expectTypeOf<() => void>().not.toExtend<OwnedDeliveryTransition>();
