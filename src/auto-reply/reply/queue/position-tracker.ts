import { defaultRuntime } from "../../../runtime.js";
import {
  reactSlackMessage,
  removeSlackReaction,
  type SlackActionClientOpts,
} from "../../../slack/actions.js";
import type { FollowupRun } from "./types.js";

/**
 * Number emoji names for Slack reactions (positions 1–10).
 */
const POSITION_EMOJIS = [
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "keycap_ten",
] as const;

/** ⏳ emoji shown while a message is being processed. */
const PROCESSING_EMOJI = "hourglass_flowing_sand";

/** Maximum queue position that gets a number reaction. */
export const MAX_TRACKED_POSITION = POSITION_EMOJIS.length;

type TrackedReaction = {
  emoji: string;
  accountId: string | undefined;
  channelId: string;
  messageId: string;
};

function getPositionEmoji(position: number): string | undefined {
  if (position < 1 || position > MAX_TRACKED_POSITION) {
    return undefined;
  }
  return POSITION_EMOJIS[position - 1];
}

function getMessageKey(run: FollowupRun): string | undefined {
  const { originatingTo, messageId } = run;
  if (!originatingTo || !messageId) {
    return undefined;
  }
  // Use JSON to avoid delimiter collisions in channel/message IDs.
  return JSON.stringify([originatingTo, messageId]);
}

function isSlackRun(run: FollowupRun): boolean {
  return run.originatingChannel === "slack";
}

/**
 * Tracks and updates number-emoji queue-position reactions on Slack messages.
 *
 * Each message in a followup queue gets a number reaction (1️⃣ 2️⃣ …) showing
 * its current position. When processing starts the number swaps to ⏳, and
 * the reaction is removed once processing completes.
 *
 * **Multi-account correctness:** every tracked entry stores the `accountId`
 * so that reaction-removal calls are always authenticated against the same
 * account that added the reaction.
 *
 * **Per-queue scoping:** use `clearQueuePositions(items)` to remove reactions
 * for a specific queue's items without touching reactions tracked for other
 * queues or channels.
 */
export class QueuePositionTracker {
  private readonly tracked = new Map<string, TrackedReaction>();

  /**
   * Adds/updates number-emoji reactions to match the current queue order.
   * Items beyond `MAX_TRACKED_POSITION` do not receive a reaction.
   * Reactions for items no longer present in `queueItems` are removed.
   */
  async updateQueuePositions(queueItems: FollowupRun[]): Promise<void> {
    const slackItems = queueItems.filter(isSlackRun);

    // Build the set of keys that should still exist after this update.
    const updatedKeys = new Set<string>();

    for (let i = 0; i < slackItems.length; i++) {
      const item = slackItems[i];
      const key = getMessageKey(item);
      if (!key) {
        continue;
      }
      updatedKeys.add(key);

      const position = i + 1;
      const newEmoji = getPositionEmoji(position);
      const existing = this.tracked.get(key);

      if (existing) {
        // Emoji unchanged — nothing to do.
        if (existing.emoji === newEmoji) {
          continue;
        }
        // Remove old reaction, then add new one (if within range).
        await this._removeReaction(
          existing.channelId,
          existing.messageId,
          existing.emoji,
          existing.accountId,
        );
        if (newEmoji) {
          await this._addReaction(
            item.originatingTo!,
            item.messageId!,
            newEmoji,
            item.originatingAccountId,
          );
          this.tracked.set(key, {
            emoji: newEmoji,
            accountId: item.originatingAccountId,
            channelId: item.originatingTo!,
            messageId: item.messageId!,
          });
        } else {
          this.tracked.delete(key);
        }
      } else if (newEmoji) {
        await this._addReaction(
          item.originatingTo!,
          item.messageId!,
          newEmoji,
          item.originatingAccountId,
        );
        this.tracked.set(key, {
          emoji: newEmoji,
          accountId: item.originatingAccountId,
          channelId: item.originatingTo!,
          messageId: item.messageId!,
        });
      }
    }

    // Remove reactions for items that are no longer in the queue.
    for (const [key, reaction] of this.tracked) {
      if (!updatedKeys.has(key)) {
        await this._removeReaction(
          reaction.channelId,
          reaction.messageId,
          reaction.emoji,
          reaction.accountId,
        );
        this.tracked.delete(key);
      }
    }
  }

  /**
   * Removes position reactions for a specific set of queue items without
   * touching reactions tracked for other queues.
   *
   * Use this in `clearFollowupQueue` / `clearSessionQueues` so that clearing
   * one queue does not accidentally wipe reactions for unrelated queues.
   */
  async clearQueuePositions(queueItems: FollowupRun[]): Promise<void> {
    for (const item of queueItems) {
      if (!isSlackRun(item)) {
        continue;
      }
      const key = getMessageKey(item);
      if (!key) {
        continue;
      }
      const reaction = this.tracked.get(key);
      if (!reaction) {
        continue;
      }
      await this._removeReaction(
        reaction.channelId,
        reaction.messageId,
        reaction.emoji,
        reaction.accountId,
      );
      this.tracked.delete(key);
    }
  }

  /**
   * Replaces the position emoji with ⏳ to signal that this message is now
   * being actively processed.
   */
  async markAsProcessing(run: FollowupRun): Promise<void> {
    if (!isSlackRun(run)) {
      return;
    }
    const key = getMessageKey(run);
    if (!key) {
      return;
    }

    const existing = this.tracked.get(key);
    if (existing?.emoji && existing.emoji !== PROCESSING_EMOJI) {
      await this._removeReaction(
        existing.channelId,
        existing.messageId,
        existing.emoji,
        existing.accountId,
      );
    }

    await this._addReaction(
      run.originatingTo!,
      run.messageId!,
      PROCESSING_EMOJI,
      run.originatingAccountId,
    );
    this.tracked.set(key, {
      emoji: PROCESSING_EMOJI,
      accountId: run.originatingAccountId,
      channelId: run.originatingTo!,
      messageId: run.messageId!,
    });
  }

  /**
   * Removes the ⏳ processing indicator once the message has been handled.
   * No-op if the message is not currently marked as processing.
   */
  async removeProcessingIndicator(run: FollowupRun): Promise<void> {
    if (!isSlackRun(run)) {
      return;
    }
    const key = getMessageKey(run);
    if (!key) {
      return;
    }
    const reaction = this.tracked.get(key);
    if (reaction?.emoji === PROCESSING_EMOJI) {
      await this._removeReaction(
        reaction.channelId,
        reaction.messageId,
        PROCESSING_EMOJI,
        reaction.accountId,
      );
      this.tracked.delete(key);
    }
  }

  /**
   * Removes all tracked reactions regardless of which queue they belong to.
   * Includes the stored `accountId` on every call so multi-account setups
   * always remove via the correct Slack credential.
   */
  async clearAll(): Promise<void> {
    for (const reaction of this.tracked.values()) {
      await this._removeReaction(
        reaction.channelId,
        reaction.messageId,
        reaction.emoji,
        reaction.accountId,
      );
    }
    this.tracked.clear();
  }

  private async _addReaction(
    channelId: string,
    messageId: string,
    emoji: string,
    accountId: string | undefined,
  ): Promise<void> {
    try {
      const opts: SlackActionClientOpts = accountId ? { accountId } : {};
      await reactSlackMessage(channelId, messageId, emoji, opts);
    } catch (err) {
      defaultRuntime.error?.(
        `queue-position-tracker: failed to add :${emoji}: to ${channelId}/${messageId}: ${String(err)}`,
      );
    }
  }

  private async _removeReaction(
    channelId: string,
    messageId: string,
    emoji: string,
    accountId: string | undefined,
  ): Promise<void> {
    try {
      const opts: SlackActionClientOpts = accountId ? { accountId } : {};
      await removeSlackReaction(channelId, messageId, emoji, opts);
    } catch (err) {
      defaultRuntime.error?.(
        `queue-position-tracker: failed to remove :${emoji}: from ${channelId}/${messageId}: ${String(err)}`,
      );
    }
  }
}

/** Singleton tracker shared across all followup queues. */
export const globalQueuePositionTracker = new QueuePositionTracker();
