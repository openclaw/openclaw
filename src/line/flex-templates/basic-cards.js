import { attachFooterText } from "./common.js";
/**
 * Create an info card with title, body, and optional footer
 *
 * Editorial design: Clean hierarchy with accent bar, generous spacing,
 * and subtle background zones for visual separation.
 */
export function createInfoCard(title, body, footer) {
    const bubble = {
        type: "bubble",
        size: "mega",
        body: {
            type: "box",
            layout: "vertical",
            contents: [
                // Title with accent bar
                {
                    type: "box",
                    layout: "horizontal",
                    contents: [
                        {
                            type: "box",
                            layout: "vertical",
                            contents: [],
                            width: "4px",
                            backgroundColor: "#06C755",
                            cornerRadius: "2px",
                        },
                        {
                            type: "text",
                            text: title,
                            weight: "bold",
                            size: "xl",
                            color: "#111111",
                            wrap: true,
                            flex: 1,
                            margin: "lg",
                        },
                    ],
                },
                // Body text in subtle container
                {
                    type: "box",
                    layout: "vertical",
                    contents: [
                        {
                            type: "text",
                            text: body,
                            size: "md",
                            color: "#444444",
                            wrap: true,
                            lineSpacing: "6px",
                        },
                    ],
                    margin: "xl",
                    paddingAll: "lg",
                    backgroundColor: "#F8F9FA",
                    cornerRadius: "lg",
                },
            ],
            paddingAll: "xl",
            backgroundColor: "#FFFFFF",
        },
    };
    if (footer) {
        attachFooterText(bubble, footer);
    }
    return bubble;
}
/**
 * Create a list card with title and multiple items
 *
 * Editorial design: Numbered/bulleted list with clear visual hierarchy,
 * accent dots for each item, and generous spacing.
 */
export function createListCard(title, items) {
    const itemContents = items.slice(0, 8).map((item, index) => {
        const itemContents = [
            {
                type: "text",
                text: item.title,
                size: "md",
                weight: "bold",
                color: "#1a1a1a",
                wrap: true,
            },
        ];
        if (item.subtitle) {
            itemContents.push({
                type: "text",
                text: item.subtitle,
                size: "sm",
                color: "#888888",
                wrap: true,
                margin: "xs",
            });
        }
        const itemBox = {
            type: "box",
            layout: "horizontal",
            contents: [
                // Accent dot
                {
                    type: "box",
                    layout: "vertical",
                    contents: [
                        {
                            type: "box",
                            layout: "vertical",
                            contents: [],
                            width: "8px",
                            height: "8px",
                            backgroundColor: index === 0 ? "#06C755" : "#DDDDDD",
                            cornerRadius: "4px",
                        },
                    ],
                    width: "20px",
                    alignItems: "center",
                    paddingTop: "sm",
                },
                // Item content
                {
                    type: "box",
                    layout: "vertical",
                    contents: itemContents,
                    flex: 1,
                },
            ],
            margin: index > 0 ? "lg" : undefined,
        };
        if (item.action) {
            itemBox.action = item.action;
        }
        return itemBox;
    });
    return {
        type: "bubble",
        size: "mega",
        body: {
            type: "box",
            layout: "vertical",
            contents: [
                {
                    type: "text",
                    text: title,
                    weight: "bold",
                    size: "xl",
                    color: "#111111",
                    wrap: true,
                },
                {
                    type: "separator",
                    margin: "lg",
                    color: "#EEEEEE",
                },
                {
                    type: "box",
                    layout: "vertical",
                    contents: itemContents,
                    margin: "lg",
                },
            ],
            paddingAll: "xl",
            backgroundColor: "#FFFFFF",
        },
    };
}
/**
 * Create an image card with image, title, and optional body text
 */
export function createImageCard(imageUrl, title, body, options) {
    const bubble = {
        type: "bubble",
        hero: {
            type: "image",
            url: imageUrl,
            size: "full",
            aspectRatio: options?.aspectRatio ?? "20:13",
            aspectMode: options?.aspectMode ?? "cover",
            action: options?.action,
        },
        body: {
            type: "box",
            layout: "vertical",
            contents: [
                {
                    type: "text",
                    text: title,
                    weight: "bold",
                    size: "xl",
                    wrap: true,
                },
            ],
            paddingAll: "lg",
        },
    };
    if (body && bubble.body) {
        bubble.body.contents.push({
            type: "text",
            text: body,
            size: "md",
            wrap: true,
            margin: "md",
            color: "#666666",
        });
    }
    return bubble;
}
/**
 * Create an action card with title, body, and action buttons
 */
export function createActionCard(title, body, actions, options) {
    const bubble = {
        type: "bubble",
        body: {
            type: "box",
            layout: "vertical",
            contents: [
                {
                    type: "text",
                    text: title,
                    weight: "bold",
                    size: "xl",
                    wrap: true,
                },
                {
                    type: "text",
                    text: body,
                    size: "md",
                    wrap: true,
                    margin: "md",
                    color: "#666666",
                },
            ],
            paddingAll: "lg",
        },
        footer: {
            type: "box",
            layout: "vertical",
            contents: actions.slice(0, 4).map((action, index) => ({
                type: "button",
                action: action.action,
                style: index === 0 ? "primary" : "secondary",
                margin: index > 0 ? "sm" : undefined,
            })),
            paddingAll: "md",
        },
    };
    if (options?.imageUrl) {
        bubble.hero = {
            type: "image",
            url: options.imageUrl,
            size: "full",
            aspectRatio: options.aspectRatio ?? "20:13",
            aspectMode: "cover",
        };
    }
    return bubble;
}
/**
 * Create a carousel container from multiple bubbles
 * LINE allows max 12 bubbles in a carousel
 */
export function createCarousel(bubbles) {
    return {
        type: "carousel",
        contents: bubbles.slice(0, 12),
    };
}
/**
 * Create a notification bubble (for alerts, status updates)
 *
 * Editorial design: Bold status indicator with accent color,
 * clear typography, optional icon for context.
 */
export function createNotificationBubble(text, options) {
    // Color based on notification type
    const colors = {
        info: { accent: "#3B82F6", bg: "#EFF6FF" },
        success: { accent: "#06C755", bg: "#F0FDF4" },
        warning: { accent: "#F59E0B", bg: "#FFFBEB" },
        error: { accent: "#EF4444", bg: "#FEF2F2" },
    };
    const typeColors = colors[options?.type ?? "info"];
    const contents = [];
    // Accent bar
    contents.push({
        type: "box",
        layout: "vertical",
        contents: [],
        width: "4px",
        backgroundColor: typeColors.accent,
        cornerRadius: "2px",
    });
    // Content section
    const textContents = [];
    if (options?.title) {
        textContents.push({
            type: "text",
            text: options.title,
            size: "md",
            weight: "bold",
            color: "#111111",
            wrap: true,
        });
    }
    textContents.push({
        type: "text",
        text,
        size: options?.title ? "sm" : "md",
        color: options?.title ? "#666666" : "#333333",
        wrap: true,
        margin: options?.title ? "sm" : undefined,
    });
    contents.push({
        type: "box",
        layout: "vertical",
        contents: textContents,
        flex: 1,
        paddingStart: "lg",
    });
    return {
        type: "bubble",
        body: {
            type: "box",
            layout: "horizontal",
            contents,
            paddingAll: "xl",
            backgroundColor: typeColors.bg,
        },
    };
}
