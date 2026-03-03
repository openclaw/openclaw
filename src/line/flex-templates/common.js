export function attachFooterText(bubble, footer) {
    bubble.footer = {
        type: "box",
        layout: "vertical",
        contents: [
            {
                type: "text",
                text: footer,
                size: "xs",
                color: "#AAAAAA",
                wrap: true,
                align: "center",
            },
        ],
        paddingAll: "lg",
        backgroundColor: "#FAFAFA",
    };
}
