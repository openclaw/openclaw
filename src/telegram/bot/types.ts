import type { Message } from "@grammyjs/types";

export type TelegramMessage = Message;

export type TelegramStreamMode = "off" | "partial" | "block";

export type TelegramContext = {
  message: TelegramMessage;
  me?: { id?: number; username?: string };
  getFile: () => Promise<{
    file_path?: string;
  }>;
};

/** Telegram Location object */
export interface TelegramLocation {
  latitude: number;
  longitude: number;
  horizontal_accuracy?: number;
  live_period?: number;
  heading?: number;
}

/** Telegram Venue object */
export interface TelegramVenue {
  location: TelegramLocation;
  title: string;
  address: string;
  foursquare_id?: string;
  foursquare_type?: string;
  google_place_id?: string;
  google_place_type?: string;
}
