import { createMemo, createSignal, onSettled, Show } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createSubmissionAction, type SubmissionPresentation } from "./submission-action.ts";

afterEach(cleanupSolid);

describe("New Session submission presentation", () => {
  it("releases the presentation before waiting for the destination to commit", async () => {
    let lifetime = Promise.withResolvers<void>();
    const owner: SubmissionPresentation = {
      get submissionLifetime() {
        return lifetime.promise;
      },
    };
    const created = Promise.withResolvers<void>();
    const destinationReady = Promise.withResolvers<void>();
    let operationFinished = false;
    let start!: () => Promise<void>;
    const view = mountSolid(() => {
      const [revision, publish] = createSignal(0);
      const [destination, setDestination] = createSignal(false);
      const outcome = createMemo(() => (destination() ? "Chat" : "Draft"));
      const saving = createSubmissionAction(
        () => owner,
        revision,
        outcome,
        (error) => {
          throw error;
        },
      );
      function Destination() {
        onSettled(() => destinationReady.resolve());
        return <h1>Chat</h1>;
      }
      start = () =>
        owner.presentSubmit!(async () => {
          await created.promise;
          // The route owner retires presentation synchronously before the new DOM commits.
          lifetime.resolve();
          lifetime = Promise.withResolvers<void>();
          publish((value) => value + 1);
          setDestination(true);
          await destinationReady.promise;
          operationFinished = true;
        });
      return (
        <>
          <span role="status">{saving() ? "Starting" : "Ready"}</span>
          <Show when={destination()} fallback={<h1>Draft</h1>}>
            <Destination />
          </Show>
        </>
      );
    });
    await waitForSolid(() => expect(owner.presentSubmit).toBeTypeOf("function"));
    const presenting = start();
    await waitForSolid(() => expect(view.getByRole("status").textContent).toBe("Starting"));
    created.resolve();
    await presenting;
    await waitForSolid(() => {
      expect(view.getByRole("heading").textContent).toBe("Chat");
      expect(view.getByRole("status").textContent).toBe("Ready");
      expect(operationFinished).toBe(true);
    });
  });

  it.each(["awaited", "fire-and-forget"])(
    "preserves a replacement outcome when a retired %s operation rejects",
    async (invocation) => {
      let lifetime = Promise.withResolvers<void>();
      const owner: SubmissionPresentation = {
        get submissionLifetime() {
          return lifetime.promise;
        },
      };
      const pending = Promise.withResolvers<void>();
      let retire!: () => void;
      const view = mountSolid(() => {
        const [revision, publish] = createSignal(0);
        const [message, setMessage] = createSignal("Original draft");
        const outcome = createMemo(message);
        const saving = createSubmissionAction(
          () => owner,
          revision,
          outcome,
          (error) => setMessage(String(error)),
        );
        retire = () => {
          lifetime.resolve();
          lifetime = Promise.withResolvers<void>();
          publish((value) => value + 1);
          setMessage("Replacement draft");
        };
        return (
          <>
            <span role="status">{saving() ? "Starting" : "Ready"}</span>
            <p>{outcome()}</p>
          </>
        );
      });
      await waitForSolid(() => expect(owner.presentSubmit).toBeTypeOf("function"));
      const presenting = owner.presentSubmit!(() => pending.promise);
      await waitForSolid(() => expect(view.getByRole("status").textContent).toBe("Starting"));
      retire();
      await waitForSolid(() => expect(view.getByRole("status").textContent).toBe("Ready"));
      const rejection =
        invocation === "awaited"
          ? expect(presenting).rejects.toThrow("Old submission failed")
          : undefined;
      pending.reject(new Error("Old submission failed"));
      await rejection;
      // Give fire-and-forget rejection reporting its own turn. Vitest fails on an unhandled promise.
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
      await waitForSolid(() => {
        expect(view.getByRole("status").textContent).toBe("Ready");
        expect(view.getByText("Replacement draft")).toBeDefined();
      });
    },
  );
});
